import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import { encodeFrame, frameReader, RUNNER_VERSION, type ClientFrame, type OutputStream, type ProcessExit, type ProcessState, type RunnerFrame } from "./wire.ts";

const STREAMS: OutputStream[] = ["stdout", "stderr"];
const REPLAY_CHUNK = 64 * 1024;

interface Managed {
  id: string;
  dir: string;
  child: ChildProcess | null;
  /** Bytes of input written to the process so far. */
  stdinAt: number;
  /** Where the client asked input to end, once the input before it arrives. */
  endAt: number | null;
  out: Record<OutputStream, number>;
  exit: ProcessExit | null;
  attached: boolean;
}

type Handlers = { [K in ClientFrame["op"]]: (frame: Extract<ClientFrame, { op: K }>) => void };

function fileSize(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => (value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]])));
}

/**
 * Owns the workspace's agent processes so they outlive any one connection from the Mac. Output is appended to disk
 * before it is sent, so a client that reconnects asks for what it missed by offset. One client at a time: a newer
 * connection replaces the older one.
 */
export class RunnerDaemon {
  private client: net.Socket | null = null;
  private readonly processes = new Map<string, Managed>();
  private readonly relays = new Map<string, Promise<number>>();
  private readonly servers: http.Server[] = [];
  private readonly requests = new Map<string, http.ServerResponse>();
  private nextRequest = 0;
  private readonly handlers: Handlers = {
    hello: () => this.send({ op: "welcome", version: RUNNER_VERSION, processes: [...this.processes.values()].map(processState) }),
    spawn: (frame) => this.spawn(frame),
    attach: (frame) => this.attach(frame),
    stdin: (frame) => this.input(frame),
    "stdin-end": (frame) => this.endInput(frame),
    signal: (frame) => this.signal(frame.id, frame.signal),
    forget: (frame) => this.forget(frame.id),
    "relay-open": (frame) => void this.openRelay(frame.name),
    "http-head": (frame) => {
      const response = this.requests.get(frame.req);
      if (response && !response.headersSent) response.writeHead(frame.status, frame.headers);
    },
    "http-data": (frame) => this.requests.get(frame.req)?.write(Buffer.from(frame.data, "base64")),
    "http-end": (frame) => {
      const response = this.requests.get(frame.req);
      this.requests.delete(frame.req);
      response?.end();
    },
  };

  private readonly state: string;

  constructor(state: string) {
    this.state = state;
    this.load();
  }

  /** Processes an earlier daemon started. One with no exit record was running when the workspace stopped. */
  private load(): void {
    const root = path.join(this.state, "processes");
    mkdirSync(root, { recursive: true });
    for (const id of readdirSync(root)) {
      const dir = path.join(root, id);
      const exitFile = path.join(dir, "exit.json");
      const exit: ProcessExit = existsSync(exitFile) ? (JSON.parse(readFileSync(exitFile, "utf8")) as ProcessExit) : { code: null, signal: null, lost: true };
      writeFileSync(exitFile, JSON.stringify(exit));
      const out = { stdout: fileSize(path.join(dir, "stdout")), stderr: fileSize(path.join(dir, "stderr")) };
      this.processes.set(id, { id, dir, child: null, stdinAt: 0, endAt: null, out, exit, attached: false });
    }
  }

  accept(socket: net.Socket): void {
    this.client?.destroy();
    this.detach();
    this.client = socket;
    const read = frameReader<ClientFrame>((frame) => (this.handlers[frame.op] as (frame: ClientFrame) => void)(frame));
    socket.on("data", (chunk: Buffer) => {
      try {
        read(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.client !== socket) return;
      this.client = null;
      this.detach();
    });
  }

  /** Ends every process, as the VM stopping would. */
  shutdown(): void {
    for (const managed of this.processes.values()) if (managed.child && !managed.exit) this.signal(managed.id, "SIGKILL");
    for (const server of this.servers) server.close();
  }

  private send(frame: RunnerFrame): void {
    if (this.client && !this.client.destroyed) this.client.write(encodeFrame(frame));
  }

  /** The client is gone: nothing is sent until one attaches again, and relayed requests it was answering fail. */
  private detach(): void {
    for (const managed of this.processes.values()) managed.attached = false;
    for (const response of this.requests.values()) {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "OpenOrc on the Mac disconnected." }));
    }
    this.requests.clear();
  }

  /** A spawn the daemon already has is not started twice; the client's retry after a reconnect lands here. */
  private spawn(frame: Extract<ClientFrame, { op: "spawn" }>): void {
    if (this.processes.has(frame.id)) return;
    const dir = path.join(this.state, "processes", frame.id);
    mkdirSync(dir, { recursive: true });
    for (const stream of STREAMS) writeFileSync(path.join(dir, stream), "");
    const managed: Managed = { id: frame.id, dir, child: null, stdinAt: 0, endAt: null, out: { stdout: 0, stderr: 0 }, exit: null, attached: false };
    this.processes.set(frame.id, managed);
    let child: ChildProcess;
    try {
      // Its own process group, so a signal reaches whatever the agent started too.
      child = spawn(frame.cmd, frame.args, { cwd: frame.cwd, env: { ...process.env, ...frame.env }, stdio: "pipe", detached: true });
    } catch (error) {
      this.finish(managed, { code: null, signal: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    managed.child = child;
    child.on("spawn", () => this.send({ op: "spawned", id: frame.id }));
    child.on("error", (error) => {
      if (!child.pid) this.finish(managed, { code: null, signal: null, error: error.message });
    });
    child.stdin?.on("error", () => undefined);
    for (const stream of STREAMS) child[stream]?.on("data", (chunk: Buffer) => this.output(managed, stream, chunk));
    child.on("close", (code, signal) => this.finish(managed, { code, signal }));
  }

  private output(managed: Managed, stream: OutputStream, chunk: Buffer): void {
    appendFileSync(path.join(managed.dir, stream), chunk);
    const at = managed.out[stream];
    managed.out[stream] += chunk.length;
    if (managed.attached) this.send({ op: "out", id: managed.id, stream, at, data: chunk.toString("base64") });
  }

  private finish(managed: Managed, exit: ProcessExit): void {
    if (managed.exit) return;
    managed.exit = exit;
    managed.child = null;
    writeFileSync(path.join(managed.dir, "exit.json"), JSON.stringify(exit));
    if (managed.attached) this.send({ op: "exit", id: managed.id, exit });
  }

  /** Sends the output after the client's offsets, then streams live. Nothing can interleave: this runs in one tick. */
  private attach(frame: Extract<ClientFrame, { op: "attach" }>): void {
    const managed = this.processes.get(frame.id);
    if (!managed) return;
    for (const stream of STREAMS) this.replay(managed, stream, frame[stream]);
    managed.attached = true;
    if (managed.exit) this.send({ op: "exit", id: managed.id, exit: managed.exit });
  }

  private replay(managed: Managed, stream: OutputStream, from: number): void {
    const end = managed.out[stream];
    if (from >= end) return;
    const fd = openSync(path.join(managed.dir, stream), "r");
    try {
      for (let at = from; at < end; at += REPLAY_CHUNK) {
        const chunk = Buffer.alloc(Math.min(REPLAY_CHUNK, end - at));
        readSync(fd, chunk, 0, chunk.length, at);
        this.send({ op: "out", id: managed.id, stream, at, data: chunk.toString("base64") });
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Input carries its offset, so a chunk resent after a reconnect is written once. */
  private input(frame: Extract<ClientFrame, { op: "stdin" }>): void {
    const managed = this.processes.get(frame.id);
    if (!managed) return;
    const data = Buffer.from(frame.data, "base64");
    const skip = managed.stdinAt - frame.at;
    if (skip >= 0 && skip < data.length) {
      managed.child?.stdin?.write(data.subarray(skip));
      managed.stdinAt = frame.at + data.length;
    }
    this.send({ op: "stdin-ack", id: managed.id, at: managed.stdinAt });
    this.closeInputWhenDone(managed);
  }

  private endInput(frame: Extract<ClientFrame, { op: "stdin-end" }>): void {
    const managed = this.processes.get(frame.id);
    if (!managed) return;
    managed.endAt = frame.at;
    this.closeInputWhenDone(managed);
  }

  private closeInputWhenDone(managed: Managed): void {
    if (managed.endAt !== null && managed.stdinAt >= managed.endAt) managed.child?.stdin?.end();
  }

  private signal(id: string, signal: string): void {
    const child = this.processes.get(id)?.child;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal as NodeJS.Signals);
    } catch {
      child.kill(signal as NodeJS.Signals);
    }
  }

  private forget(id: string): void {
    const managed = this.processes.get(id);
    if (!managed?.exit) return;
    this.processes.delete(id);
    rmSync(managed.dir, { recursive: true, force: true });
  }

  /** A loopback address in the VM whose requests are answered by the Mac. The same name keeps the same port. */
  private async openRelay(name: string): Promise<void> {
    let port = this.relays.get(name);
    if (!port) {
      const server = http.createServer((request, response) => this.forward(name, request, response));
      this.servers.push(server);
      port = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
      this.relays.set(name, port);
    }
    this.send({ op: "relay-ready", name, port: await port });
  }

  private forward(name: string, request: http.IncomingMessage, response: http.ServerResponse): void {
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      if (!this.client) {
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "OpenOrc on the Mac is not connected." }));
        return;
      }
      const req = String(++this.nextRequest);
      this.requests.set(req, response);
      response.on("close", () => {
        if (this.requests.delete(req)) this.send({ op: "http-abort", req });
      });
      const headers = flattenHeaders(request.headers);
      this.send({ op: "http", req, name, method: request.method ?? "GET", url: request.url ?? "/", headers, body: Buffer.concat(body).toString("base64") });
    });
  }
}

function processState(managed: Managed): ProcessState {
  return { id: managed.id, stdinAt: managed.stdinAt, stdout: managed.out.stdout, stderr: managed.out.stderr, exit: managed.exit };
}

function reachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Serves the workspace on `socketPath` unless a daemon already does. */
export async function startDaemon(state: string, socketPath: string): Promise<void> {
  if (await reachable(socketPath)) return;
  rmSync(socketPath, { force: true });
  const daemon = new RunnerDaemon(state);
  const server = net.createServer((socket) => daemon.accept(socket));
  server.listen(socketPath);
  process.once("SIGTERM", () => {
    daemon.shutdown();
    server.close();
    rmSync(socketPath, { force: true });
    process.exit(0);
  });
}
