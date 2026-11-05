import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileBoundaryAnswer } from "./file-boundary.ts";
import { encodeFrame, frameReader, RUNNER_VERSION, type ClientFrame, type OutputStream, type ProcessExit, type ProcessState, type RunnerFrame, type Takeover, type TakeoverStarted } from "./wire.ts";

const STREAMS: OutputStream[] = ["stdout", "stderr"];
const REPLAY_CHUNK = 64 * 1024;
const TAKEOVER_FILE = "takeover.json";

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
  /** What to start if the Mac goes away mid-turn, with the timer that starts it while the Mac is gone. */
  private standby: { takeover: Takeover; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** The takeover started here, kept on disk until the Mac has seen it. */
  private started: TakeoverStarted | null = null;
  private readonly handlers: Handlers = {
    hello: () => this.send({ op: "welcome", version: RUNNER_VERSION, home: os.homedir(), processes: [...this.processes.values()].map(processState), takeover: this.started }),
    standby: (frame) => this.arm(frame.takeover),
    "standby-off": () => this.disarm(),
    away: () => {
      this.takeOver();
      this.send({ op: "took-over", takeover: this.started });
    },
    "takeover-seen": () => {
      this.started = null;
      rmSync(path.join(this.state, TAKEOVER_FILE), { force: true });
    },
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
    const takeover = path.join(this.state, TAKEOVER_FILE);
    if (existsSync(takeover)) this.started = JSON.parse(readFileSync(takeover, "utf8")) as TakeoverStarted;
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

  /**
   * A connection becomes the Mac's once it says hello, and the one before it closes then. Until then it is ignored: a
   * daemon starting up checks this one is running by connecting, and that check must not cut the Mac off.
   */
  accept(socket: net.Socket): void {
    // A frame a newer Mac sends that this runner does not know is ignored, not a reason to drop the Mac.
    const read = frameReader<ClientFrame>((frame) => {
      if (frame.op === "hello") this.take(socket);
      if (this.client === socket) (this.handlers[frame.op] as ((frame: ClientFrame) => void) | undefined)?.(frame);
    });
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
      this.awaitMac();
    });
  }

  private take(socket: net.Socket): void {
    if (this.client === socket) return;
    this.client?.destroy();
    this.detach();
    this.client = socket;
    // The Mac is back: a takeover waiting on its absence waits on.
    if (this.standby?.timer) clearTimeout(this.standby.timer);
    if (this.standby) this.standby.timer = null;
  }

  private arm(takeover: Takeover): void {
    if (this.standby?.timer) clearTimeout(this.standby.timer);
    this.standby = { takeover, timer: null };
    if (!this.client) this.awaitMac();
  }

  private disarm(): void {
    if (this.standby?.timer) clearTimeout(this.standby.timer);
    this.standby = null;
  }

  /** Starts the takeover once the Mac has been gone for its wait, unless it comes back first. */
  private awaitMac(): void {
    const standby = this.standby;
    if (!standby || standby.timer) return;
    standby.timer = setTimeout(() => this.takeOver(), standby.takeover.afterMs);
    standby.timer.unref();
  }

  /** The agent carries on here. Its prompt is in its arguments, so its input closes at once. */
  private takeOver(): void {
    const standby = this.standby;
    if (!standby) return;
    this.disarm();
    const { id, cmd, args, cwd, env } = standby.takeover;
    this.started = { id, at: Date.now() };
    writeFileSync(path.join(this.state, TAKEOVER_FILE), JSON.stringify(this.started));
    this.spawn({ op: "spawn", id, cmd, args, cwd, env });
    this.endInput({ op: "stdin-end", id, at: 0 });
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
      for (const dir of frame.dirs ?? []) mkdirSync(dir, { recursive: true });
      for (const file of frame.files ?? []) {
        mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
        writeFileSync(file.path, file.content, { mode: 0o600 });
      }
      // Its own process group, so a signal reaches whatever the agent started too.
      // PWD follows cwd: some CLIs (OpenCode) read their folder from it, and the daemon's own would be wrong.
      child = spawn(frame.cmd, frame.args, { cwd: frame.cwd, env: { ...process.env, ...frame.env, ...(frame.cwd ? { PWD: frame.cwd } : {}) }, stdio: "pipe", detached: true });
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
      // The check needs this VM's files, so it is answered here, and works while the Mac is away.
      const boundary = /\/file-boundary$/.test(new URL(request.url ?? "/", "http://runner").pathname);
      if (boundary && request.method === "POST") {
        answerBoundary(request.url ?? "/", Buffer.concat(body), response);
        return;
      }
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

function answerBoundary(url: string, body: Buffer, response: http.ServerResponse): void {
  try {
    const answer = fileBoundaryAnswer(new URL(url, "http://runner").searchParams, JSON.parse(body.toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
