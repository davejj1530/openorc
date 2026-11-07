import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteProcess, type PendingInput, type RemoteCommand } from "./remote-process.js";
import type { Sandbox, SandboxStream } from "./sandbox.js";
import { encodeFrame, frameReader, type ClientFrame, type ProcessState, type RunnerFrame, type Takeover, type TakeoverStarted } from "./runner/wire.js";

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

/**
 * Puts the runner in the sandbox, unless it holds this one already, as a sandbox made from a base or opened again does:
 * a marker names what is there, written last so an install cut short is done again.
 */
export async function installRunner(sandbox: Sandbox, files: RunnerFile[], node = "node"): Promise<RunnerInstall> {
  const state = path.posix.join(sandbox.root, ".openorc");
  const dir = path.posix.join(state, "runner");
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) hash.update(`${file.name}\0`).update(file.content).update("\0");
  const digest = hash.digest("hex");
  const marker = path.posix.join(dir, ".installed");
  const installed = (await sandbox.readFile(marker).catch(() => null))?.toString("utf8");
  if (installed !== digest) {
    for (const file of files) await sandbox.writeFile(path.posix.join(dir, file.name), file.content);
    await sandbox.writeFile(path.posix.join(dir, "package.json"), Buffer.from(`{"type":"module"}\n`));
    await sandbox.writeFile(marker, Buffer.from(digest));
  }
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
  private welcome: ((frame: Extract<RunnerFrame, { op: "welcome" }>) => void) | null = null;
  private vmHome = "";
  private readonly processes = new Map<string, RemoteProcess>();
  private readonly signals = new Map<string, string>();
  private readonly relays = new Map<string, Relay>();
  private readonly requests = new Map<string, AbortController>();
  /** Processes the runner started on its own, which a reconnect attaches to again but never starts. */
  private readonly adopted = new Set<string>();
  /** The takeover armed now, sent again after a reconnect. */
  private armed: Takeover | null = null;
  private started: TakeoverStarted | null = null;
  private readonly awayWaiters: Array<(started: TakeoverStarted | null) => void> = [];
  private readonly handlers: FrameHandlers = {
    welcome: (frame) => this.welcome?.(frame),
    spawned: (frame) => this.processes.get(frame.id)?.markStarted(),
    out: (frame) => this.processes.get(frame.id)?.receive(frame.stream, frame.at, Buffer.from(frame.data, "base64")),
    exit: (frame) => this.processes.get(frame.id)?.finish(frame.exit),
    "stdin-ack": (frame) => this.processes.get(frame.id)?.acknowledge(frame.at),
    "relay-ready": (frame) => this.relayReady(frame.name, frame.port),
    "took-over": (frame) => {
      this.started = frame.takeover;
      for (const waiter of this.awayWaiters.splice(0)) waiter(frame.takeover);
    },
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

  /** The home folder of the VM's user. */
  get home(): string {
    return this.vmHome;
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

  /**
   * Arms what the sandbox starts on its own if this Mac goes away mid-turn: when told so with `away`, or once nothing
   * has been connected for the takeover's wait. Replaces one armed before.
   */
  standby(takeover: Takeover): void {
    this.armed = takeover;
    this.send({ op: "standby", takeover });
  }

  standbyOff(): void {
    this.armed = null;
    this.send({ op: "standby-off" });
  }

  /**
   * This Mac is going away now: an armed takeover starts. Resolves with it once the runner says so, or with null when
   * none was armed or no answer came within `timeoutMs`, as when the network is already gone.
   */
  away(timeoutMs = 3000): Promise<TakeoverStarted | null> {
    if (!this.stream) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.awayWaiters.push((started) => {
        clearTimeout(timer);
        resolve(started);
      });
      this.send({ op: "away" });
    });
  }

  /** The takeover the sandbox started while this Mac was away, as of the last connection; null when none did. */
  get takeover(): TakeoverStarted | null {
    return this.started;
  }

  /** The Mac has taken the takeover in: the runner forgets it, and a new standby can be armed. */
  takeoverSeen(): void {
    this.started = null;
    this.send({ op: "takeover-seen" });
  }

  /** A process the runner started on its own, such as a takeover: its output from the start, then live. */
  adopt(id: string): RemoteProcess {
    const existing = this.processes.get(id);
    if (existing) return existing;
    const proc = new RemoteProcess(id, { cmd: "", args: [], cwd: "", env: {} }, this.link);
    this.processes.set(id, proc);
    this.adopted.add(id);
    proc.once("close", () => {
      this.processes.delete(id);
      this.adopted.delete(id);
    });
    this.send({ op: "attach", id, stdout: 0, stderr: 0 });
    return proc;
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
      const welcome = await new Promise<Extract<RunnerFrame, { op: "welcome" }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The cloud workspace's runner did not answer.")), WELCOME_TIMEOUT_MS);
        this.welcome = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        void stream.ended.then(() => reject(new Error("The cloud workspace's runner closed the connection.")));
        stream.input.write(encodeFrame({ op: "hello" }));
      });
      this.stream = stream;
      this.vmHome = welcome.home;
      this.started = welcome.takeover ?? null;
      // A takeover that started used up the standby; one still armed in the runner's memory is gone after a restart.
      if (this.started) this.armed = null;
      else if (this.armed) this.send({ op: "standby", takeover: this.armed });
      this.resume(welcome.processes);
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
      else if (this.adopted.has(proc.id)) {
        // The runner lost what it started on its own, as when its VM restarted.
        proc.finish({ code: null, signal: null, lost: true });
        continue;
      } else this.send({ op: "spawn", id: proc.id, ...proc.command });
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
      const answer: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name)) answer[name] = value;
      });
      this.send({ op: "http-head", req: frame.req, status: response.status, headers: answer });
      answered = true;
      const reader = response.body?.getReader();
      for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) this.send({ op: "http-data", req: frame.req, data: Buffer.from(chunk.value).toString("base64") });
    } catch {
      if (controller.signal.aborted) return;
      if (!answered) this.send({ op: "http-head", req: frame.req, status: 502, headers: {} });
    } finally {
      this.requests.delete(frame.req);
    }
    this.send({ op: "http-end", req: frame.req });
  }
}
