import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteProcess, type PendingInput, type RemoteCommand } from "./remote-process.js";
import type { Sandbox, SandboxStream } from "./sandbox.js";
import { encodeFrame, frameReader, type ClientFrame, type ProcessState, type RunnerFrame } from "./runner/wire.js";

export interface RunnerFile {
  name: string;
  content: Buffer;
}

/** Where the runner lives in one VM, once its files are there. */
export interface RunnerInstall {
  readonly sandbox: Sandbox;
  readonly node: string;
  readonly script: string;
  /** The runner's own folder in the VM, outside the checkout. */
  readonly state: string;
}

export type RunnerConnectionState = "connected" | "disconnected" | "closed";

/** Request and response headers that describe one hop, not the message. */
const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "upgrade", "proxy-connection", "te", "trailer"]);
const WELCOME_TIMEOUT_MS = 20_000;

/** The runner's source files from this package. The VM runs them with its own Node, which strips the types. */
export function runnerFiles(): RunnerFile[] {
  const dir = fileURLToPath(new URL("./runner/", import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, content: readFileSync(path.join(dir, name)) }));
}

export async function installRunner(sandbox: Sandbox, files: RunnerFile[], node = "node"): Promise<RunnerInstall> {
  const state = path.posix.join(sandbox.root, ".openorc");
  const dir = path.posix.join(state, "runner");
  for (const file of files) await sandbox.writeFile(path.posix.join(dir, file.name), file.content);
  await sandbox.writeFile(path.posix.join(dir, "package.json"), Buffer.from(`{"type":"module"}\n`));
  return { sandbox, node, script: path.posix.join(dir, "runner.ts"), state };
}

/** Runs one runner command to completion and returns the JSON it printed. */
export async function runRunner<T>(install: RunnerInstall, command: string, args: string[]): Promise<T> {
  const result = await install.sandbox.exec(install.node, [install.script, command, "--state", install.state, ...args]);
  if (result.code !== 0) throw new Error(`The cloud workspace could not ${command}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return JSON.parse(result.stdout.toString("utf8").trim().split("\n").pop() ?? "null") as T;
}

interface Relay {
  target: string;
  port: number | null;
  waiters: Array<(port: number) => void>;
}

type FrameHandlers = { [K in RunnerFrame["op"]]: (frame: Extract<RunnerFrame, { op: K }>) => void };

/**
 * The Mac's connection to one workspace's runner. It reconnects on its own; processes keep running in the VM
 * meanwhile, and on reconnect each resumes its output and resends unacknowledged input by offset.
 */
export class RunnerClient {
  private stream: SandboxStream | null = null;
  private closed = false;
  private welcome: ((processes: ProcessState[]) => void) | null = null;
  private readonly processes = new Map<string, RemoteProcess>();
  private readonly signals = new Map<string, string>();
  private readonly relays = new Map<string, Relay>();
  private readonly requests = new Map<string, AbortController>();
  private readonly handlers: FrameHandlers = {
    welcome: (frame) => this.welcome?.(frame.processes),
    spawned: (frame) => this.processes.get(frame.id)?.markStarted(),
    out: (frame) => this.processes.get(frame.id)?.receive(frame.stream, frame.at, Buffer.from(frame.data, "base64")),
    exit: (frame) => this.processes.get(frame.id)?.finish(frame.exit),
    "stdin-ack": (frame) => this.processes.get(frame.id)?.acknowledge(frame.at),
    "relay-ready": (frame) => this.relayReady(frame.name, frame.port),
    http: (frame) => void this.forward(frame),
    "http-abort": (frame) => this.requests.get(frame.req)?.abort(),
  };
  private readonly link = {
    sendInput: (id: string, input: PendingInput) => this.send({ op: "stdin", id, at: input.at, data: input.data.toString("base64") }),
    endInput: (id: string, at: number) => this.send({ op: "stdin-end", id, at }),
    signal: (id: string, signal: string) => {
      if (this.stream) this.send({ op: "signal", id, signal });
      else this.signals.set(id, signal);
    },
  };

  private constructor(
    readonly install: RunnerInstall,
    private readonly onState: (state: RunnerConnectionState) => void,
  ) {}

  static async open(install: RunnerInstall, onState: (state: RunnerConnectionState) => void = () => undefined): Promise<RunnerClient> {
    const client = new RunnerClient(install, onState);
    const stream = await client.connect();
    void client.keepConnected(stream);
    return client;
  }

  get connected(): boolean {
    return this.stream !== null;
  }

  /** Starts a process in the VM. It keeps running while the Mac is away. */
  spawn(id: string, command: RemoteCommand): RemoteProcess {
    if (this.processes.has(id)) throw new Error(`A cloud process named ${id} is already running.`);
    const proc = new RemoteProcess(id, command, this.link);
    this.processes.set(id, proc);
    proc.once("close", () => {
      this.processes.delete(id);
      this.send({ op: "forget", id });
    });
    this.send({ op: "spawn", id, ...command });
    this.send({ op: "attach", id, stdout: 0, stderr: 0 });
    return proc;
  }

  /** A port on the VM's loopback whose requests reach `target` on the Mac. Stable while the runner runs. */
  relay(name: string, target: string): Promise<number> {
    let relay = this.relays.get(name);
    if (!relay) {
      relay = { target, port: null, waiters: [] };
      this.relays.set(name, relay);
      this.send({ op: "relay-open", name });
    }
    if (relay.port !== null) return Promise.resolve(relay.port);
    const pending = relay;
    return new Promise((resolve) => pending.waiters.push(resolve));
  }

  /** Disconnects. Processes in the VM keep running. */
  close(): void {
    this.closed = true;
    this.stream?.close();
    this.onState("closed");
  }

  private send(frame: ClientFrame): void {
    if (this.stream) this.stream.input.write(encodeFrame(frame));
  }

  private async connect(): Promise<SandboxStream> {
    const { sandbox, node, script, state } = this.install;
    await sandbox.launch(node, [script, "daemon", "--state", state]);
    const stream = await sandbox.stream(node, [script, "bridge", "--state", state]);
    const read = frameReader<RunnerFrame>((frame) => (this.handlers[frame.op] as (frame: RunnerFrame) => void)(frame));
    stream.output.on("data", (chunk: Buffer) => read(chunk));
    void stream.ended.then(() => this.lost(stream));
    try {
      const processes = await new Promise<ProcessState[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The cloud workspace's runner did not answer.")), WELCOME_TIMEOUT_MS);
        this.welcome = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        void stream.ended.then(() => reject(new Error("The cloud workspace's runner closed the connection.")));
        stream.input.write(encodeFrame({ op: "hello" }));
      });
      this.stream = stream;
      this.resume(processes);
      this.onState("connected");
      return stream;
    } catch (error) {
      stream.close();
      throw error;
    } finally {
      this.welcome = null;
    }
  }

  /** Brings the runner up to date with everything that happened while disconnected. */
  private resume(processes: ProcessState[]): void {
    const known = new Map(processes.map((state) => [state.id, state]));
    for (const proc of this.processes.values()) {
      const state = known.get(proc.id);
      if (state) proc.acknowledge(state.stdinAt);
      else this.send({ op: "spawn", id: proc.id, ...proc.command });
      this.send({ op: "attach", id: proc.id, stdout: proc.received.stdout, stderr: proc.received.stderr });
      for (const input of proc.unacked) this.link.sendInput(proc.id, input);
      if (proc.inputEnd !== null) this.link.endInput(proc.id, proc.inputEnd);
      const signal = this.signals.get(proc.id);
      if (signal) this.send({ op: "signal", id: proc.id, signal });
    }
    this.signals.clear();
    for (const [name, relay] of this.relays) {
      relay.port = null;
      this.send({ op: "relay-open", name });
    }
  }

  private lost(stream: SandboxStream): void {
    if (this.stream !== stream) return;
    this.stream = null;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    if (!this.closed) this.onState("disconnected");
  }

  private async keepConnected(first: SandboxStream): Promise<void> {
    let stream: SandboxStream | null = first;
    let delay = 250;
    while (!this.closed) {
      if (stream) {
        await stream.ended;
        stream = null;
        delay = 250;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5000);
      if (this.closed) return;
      stream = await this.connect().catch(() => null);
    }
  }

  private relayReady(name: string, port: number): void {
    const relay = this.relays.get(name);
    if (!relay) return;
    relay.port = port;
    for (const waiter of relay.waiters.splice(0)) waiter(port);
  }

  private async forward(frame: Extract<RunnerFrame, { op: "http" }>): Promise<void> {
    const controller = new AbortController();
    this.requests.set(frame.req, controller);
    let answered = false;
    try {
      const relay = this.relays.get(frame.name);
      if (!relay) throw new Error(`No relay named ${frame.name}`);
      const headers = Object.fromEntries(Object.entries(frame.headers).filter(([name]) => !HOP_HEADERS.has(name)));
      const body = frame.method === "GET" || frame.method === "HEAD" ? undefined : Buffer.from(frame.body, "base64");
      const response = await fetch(new URL(frame.url, relay.target), { method: frame.method, headers, body: body ?? null, signal: controller.signal });
      this.send({ op: "http-head", req: frame.req, status: response.status, headers: Object.fromEntries([...response.headers].filter(([name]) => !HOP_HEADERS.has(name))) });
      answered = true;
      if (response.body) for await (const chunk of response.body) this.send({ op: "http-data", req: frame.req, data: Buffer.from(chunk).toString("base64") });
    } catch {
      if (controller.signal.aborted) return;
      if (!answered) this.send({ op: "http-head", req: frame.req, status: 502, headers: {} });
    } finally {
      this.requests.delete(frame.req);
    }
    this.send({ op: "http-end", req: frame.req });
  }
}
