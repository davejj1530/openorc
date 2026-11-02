import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SANDBOX_AWAY_MS, type Sandbox, type SandboxCommandOptions, type SandboxExecResult, type SandboxInfo, type SandboxProvider, type SandboxStream } from "./sandbox.js";

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* Already gone. */
  }
}

/**
 * Stands in for a cloud VM in development and tests. A folder on this Mac is the VM's disk and its commands are local
 * processes, each in its own process group. Stopping it ends every process it started, as a VM going to sleep would,
 * and keeps the files. Like a VM's session, it stops on its own once nobody keeps it awake, and the next command
 * starts it again.
 */
export class LocalSandbox implements Sandbox {
  private readonly running = new Set<ChildProcess>();
  private readonly streams = new Set<ChildProcess>();
  private session: { timer: ReturnType<typeof setTimeout>; startedAt: number; endsAt: number } | null = null;
  /** How long it ran in the sessions that ended since the app started. */
  private pastMs = 0;

  constructor(
    readonly name: string,
    readonly root: string,
    private readonly env: () => NodeJS.ProcessEnv,
    readonly awayMs = SANDBOX_AWAY_MS,
  ) {}

  /** Starts a session when none runs. */
  private wake(): void {
    if (!this.session) this.endSessionIn(this.awayMs);
  }

  private endSessionIn(ms: number): void {
    if (this.session) clearTimeout(this.session.timer);
    const timer = setTimeout(() => void this.stop(), ms);
    timer.unref();
    this.session = { timer, startedAt: this.session?.startedAt ?? Date.now(), endsAt: Date.now() + ms };
  }

  /** When the running session began, and how long it has run in all, as far as this app has seen. */
  awake(): { since: number | null; ms: number } {
    const since = this.session?.startedAt ?? null;
    return { since, ms: this.pastMs + (since === null ? 0 : Date.now() - since) };
  }

  async keepAwake(): Promise<void> {
    this.wake();
    if (this.session && this.session.endsAt < Date.now() + this.awayMs) this.endSessionIn(this.awayMs);
  }

  private start(cmd: string, args: string[], options: SandboxCommandOptions, stdio: StdioOptions): ChildProcess {
    this.wake();
    const child = spawn(cmd, args, { cwd: options.cwd ?? this.root, env: { ...this.env(), ...options.env }, stdio, detached: true });
    this.running.add(child);
    child.once("close", () => this.running.delete(child));
    child.once("error", () => this.running.delete(child));
    return child;
  }

  exec(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxExecResult> {
    return new Promise((resolve, reject) => {
      const child = this.start(cmd, args, options, ["ignore", "pipe", "pipe"]);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
  }

  async launch(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<void> {
    const child = this.start(cmd, args, options, "ignore");
    child.unref();
    await once(child, "spawn");
  }

  async stream(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxStream> {
    const child = this.start(cmd, args, options, ["pipe", "pipe", "ignore"]);
    this.streams.add(child);
    const ended = new Promise<void>((resolve) => child.once("close", () => resolve()));
    void ended.then(() => this.streams.delete(child));
    await once(child, "spawn");
    child.stdin?.on("error", () => undefined);
    if (!child.stdin || !child.stdout) throw new Error("The sandbox stream has no pipes.");
    return { input: child.stdin, output: child.stdout, ended, close: () => signalGroup(child, "SIGKILL") };
  }

  async writeFile(file: string, content: Buffer): Promise<void> {
    this.wake();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async readFile(file: string): Promise<Buffer | null> {
    this.wake();
    try {
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Cuts every connection into the VM and leaves its processes running, as a network drop would. */
  dropConnections(): void {
    for (const child of this.streams) signalGroup(child, "SIGKILL");
  }

  async stop(): Promise<void> {
    if (this.session) {
      clearTimeout(this.session.timer);
      this.pastMs += Date.now() - this.session.startedAt;
    }
    this.session = null;
    const running = [...this.running];
    const closed = running.map((child) => (child.exitCode === null && child.signalCode === null ? once(child, "close") : Promise.resolve()));
    for (const child of running) signalGroup(child, "SIGTERM");
    const timer = setTimeout(() => running.forEach((child) => signalGroup(child, "SIGKILL")), 2000);
    await Promise.all(closed);
    clearTimeout(timer);
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly id = "local";
  private readonly sandboxes = new Map<string, LocalSandbox>();

  /** `env` is read for every command, so a later PATH reaches the processes started after it. */
  constructor(
    private readonly base: string,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
    private readonly awayMs = SANDBOX_AWAY_MS,
  ) {}

  /** Its sandboxes are processes on this Mac, so they stop with the app that started them. */
  async close(): Promise<void> {
    await Promise.all([...this.sandboxes.values()].map((sandbox) => sandbox.stop()));
  }

  async open(name: string): Promise<LocalSandbox> {
    const existing = this.sandboxes.get(name);
    if (existing) return existing;
    const root = path.join(this.base, name);
    await mkdir(root, { recursive: true });
    const sandbox = new LocalSandbox(name, root, this.env, this.awayMs);
    this.sandboxes.set(name, sandbox);
    return sandbox;
  }

  /** Its sandboxes' folders; how long each ran is known only for this app's lifetime, and a simulated one costs nothing. */
  async list(): Promise<SandboxInfo[]> {
    const names = await readdir(this.base).catch(() => [] as string[]);
    return Promise.all(
      names.map(async (name) => {
        const awake = this.sandboxes.get(name)?.awake() ?? { since: null, ms: 0 };
        const created = (await stat(path.join(this.base, name))).birthtimeMs;
        return {
          name,
          state: awake.since === null ? "stopped" : "running",
          createdAt: created,
          awakeSince: awake.since,
          awakeMs: awake.ms,
          vcpus: null,
          memoryMb: null,
          costUsd: null,
        } satisfies SandboxInfo;
      }),
    );
  }

  async remove(name: string): Promise<void> {
    await this.sandboxes.get(name)?.stop();
    this.sandboxes.delete(name);
    await rm(path.join(this.base, name), { recursive: true, force: true });
  }
}
