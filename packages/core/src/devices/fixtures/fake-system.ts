import { writeFile } from "node:fs/promises";
import path from "node:path";
import { nodeSystem, type ChildHandle, type DeviceSystem, type ProcessEnv, type RunResult } from "../system.js";
import { FakeHub } from "./fake-hub.js";

export interface RunCall {
  command: string;
  args: string[];
  env?: ProcessEnv | undefined;
  cwd?: string | undefined;
}

type RunHandler = (call: RunCall) => Partial<RunResult> | Promise<Partial<RunResult>> | undefined;

/** A fake hub process: the fake hub server listening on the port it was given, publishing its token like the real one. */
export interface SpawnedHub {
  pid: number;
  port: number;
  args: string[];
  env: ProcessEnv;
  hub: Promise<FakeHub>;
  /** The process dies on its own. */
  crash(code?: number): Promise<void>;
}

/**
 * The machine as the device helpers see it, with nothing real behind it but loopback sockets and files: commands answer
 * from handlers, `spawn` starts a fake hub, signals end fake processes, delays end at once, and the clock moves only
 * when a test sets it.
 */
export class FakeSystem implements DeviceSystem {
  platform: NodeJS.Platform = "darwin";
  clock = 1_000_000;
  readonly runs: RunCall[] = [];
  readonly signals: { pid: number; signal: NodeJS.Signals }[] = [];
  readonly live = new Map<number, string>();
  readonly hubs: SpawnedHub[] = [];
  onDelay: (ms: number) => void = () => undefined;
  private readonly handlers: RunHandler[] = [];
  private nextPid = 40_000;

  constructor(readonly home: string) {}

  /** Answers commands `match` accepts. Later handlers win. */
  on(match: (call: RunCall) => boolean, result: Partial<RunResult> | ((call: RunCall) => Partial<RunResult> | Promise<Partial<RunResult>>)): void {
    const answer = typeof result === "function" ? result : () => result;
    this.handlers.unshift((call) => (match(call) ? answer(call) : undefined));
  }

  /** A process the test pretends is running, visible to `ps`. */
  process(command: string): number {
    const pid = this.nextPid++;
    this.live.set(pid, command);
    return pid;
  }

  async run(command: string, args: string[], options: { env?: ProcessEnv; cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const call = { command, args, env: options.env, cwd: options.cwd };
    this.runs.push(call);
    if (command === "ps") return this.ps(args);
    for (const handler of this.handlers) {
      const result = await handler(call);
      if (result) return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  }

  spawn(command: string, args: string[], options: { env: ProcessEnv; onOutput(line: string): void }): ChildHandle {
    const pid = this.process(`${command} ${args.join(" ")}`);
    const port = Number(args[args.indexOf("--port") + 1]);
    let exit!: (value: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => (exit = resolve));
    const hub = new FakeHub(`token-${pid}`).listen(port).then(async (server) => {
      const stateDir = options.env["EXPO_DEVICE_HUB_STATE_DIR"]!;
      await writeFile(path.join(stateDir, `server-${port}.json`), JSON.stringify({ pid, port, url: `http://127.0.0.1:${port}`, token: server.token }));
      // The real hub prints its link, token included, when it is ready.
      options.onOutput(`  Local:   http://localhost:${port}/?token=${server.token}`);
      return server;
    });
    const end = async (code: number | null, signal: string | null) => {
      if (!this.live.delete(pid)) return;
      await (await hub).close();
      exit({ code, signal });
    };
    this.hubs.push({ pid, port, args, env: options.env, hub, crash: (code = 1) => end(code, null) });
    return { pid, exited, kill: (signal) => void end(null, signal) };
  }

  alive(pid: number): boolean {
    return this.live.has(pid);
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
    const hub = this.hubs.find((item) => item.pid === pid);
    if (hub) void hub.crash();
    else this.live.delete(pid);
  }

  reservePort(): Promise<number> {
    return nodeSystem.reservePort();
  }

  now(): number {
    return this.clock;
  }

  async delay(ms: number): Promise<void> {
    this.onDelay(ms);
    await new Promise((resolve) => setImmediate(resolve));
  }

  private ps(args: string[]): RunResult {
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    if (args[0] === "-axo") return ok([...this.live].map(([pid, command]) => `${pid} ${command}`).join("\n"));
    const command = this.live.get(Number(args.at(-1)));
    return command ? ok(`${command}\n`) : { code: 1, stdout: "", stderr: "", timedOut: false };
  }
}
