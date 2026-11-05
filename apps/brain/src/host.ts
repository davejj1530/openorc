import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  BRAIN_EXIT,
  BRAIN_READY,
  agent37Self,
  brainLayout,
  brainSelf,
  parseLaunch,
  type BrainControlRequest,
  type BrainLayout,
  type BrainSelf,
  type BrainStart,
  type BrainStatus,
  type RunnerFile,
} from "@openorc/cloud";
import { OpenOrc, usesHost, type RequestOrigin, type RpcReply } from "@openorc/core";
import { useGitHubSignIn } from "@openorc/git";
import type { RpcRequest } from "@openorc/protocol";
import { BrainAwake, NO_SANDBOX, type SleepReason } from "./awake.js";
import { serveControl, type ControlServer } from "./control.js";
import { controlHandlers, retireSignedOut, type CoreOp } from "./control-ops.js";
import { BrainGitHub, GITHUB_CHANNEL } from "./github.js";
import { readLine } from "./line.js";
import { BrainLog } from "./log.js";
import { brainPath, missingTools } from "./machine-check.js";
import { brainOptions } from "./options.js";
import { SealedSecrets, WrongBrainKey } from "./secrets.js";

type Phase = BrainStatus["state"];
type CoreRequest = Extract<BrainControlRequest, { op: CoreOp }>;

/** What a request hears while the brain cannot take it. */
const NOT_READY: Record<Exclude<Phase, "ready">, string> = { starting: "The cloud brain is starting.", closing: "The cloud brain is closing." };
const FAILED = 1;

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Says why on stderr, where whoever started the brain reads it, and in the log, then exits with `code`. */
function exitWith(log: BrainLog, code: number, reason: string): never {
  log.write("error", reason);
  process.stderr.write(`${reason}\n`);
  process.exit(code);
}

/** The start line, the machine and the key, each refused with its own exit before the core opens anything. */
async function boot(layout: BrainLayout, log: BrainLog): Promise<{ start: BrainStart; secrets: SealedSecrets }> {
  let start: BrainStart;
  try {
    start = parseLaunch(await readLine(process.stdin, { maxBytes: 64 * 1024, timeoutMs: 5_000 }));
  } catch (error) {
    exitWith(log, BRAIN_EXIT.badStart, words(error));
  }
  process.stdin.destroy();
  // Kept in an Agent37 instance's env for its boot hook; the agents and tools the brain starts get none of it.
  delete process.env["OPENORC_BRAIN_START"];
  const missing = await missingTools(brainPath(layout));
  if (missing.length) exitWith(log, BRAIN_EXIT.needsProvision, `The brain's machine lacks ${missing.join(", ")}.`);
  try {
    return { start, secrets: await SealedSecrets.open(layout.secrets, start.key) };
  } catch (error) {
    if (error instanceof WrongBrainKey) exitWith(log, BRAIN_EXIT.wrongKey, error.message);
    throw error;
  }
}

/** The brain's handle on its own machine, from the service its start line names. */
function selfOf(start: BrainStart): BrainSelf {
  if (start.vercel) return brainSelf(start.vercel.connection, start.vercel.sandbox);
  return start.agent37 ? agent37Self(start.agent37.connection, start.agent37.instance) : NO_SANDBOX;
}

/** The runner's source files the build put beside the entry points; cloud sandboxes are given them as they are. */
async function runnerFiles(appDir: string): Promise<RunnerFile[]> {
  const dir = path.join(appDir, "runner");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(path.join(dir, name)) })));
}

/** The running brain's state, which `status` reports and every way in checks. */
class Host {
  phase: Phase = "starting";
  core: OpenOrc | null = null;
  ops: ((request: CoreRequest) => Promise<unknown>) | null = null;
  control: ControlServer | null = null;
  awake: BrainAwake | null = null;
  private readonly since = Date.now();

  constructor(
    private readonly version: string,
    private readonly self: BrainSelf,
    private readonly log: BrainLog,
  ) {}

  /**
   * Phones' requests, refused once the brain is closing so nothing new starts under it. Each one starts the idle clock
   * again, so a phone that looked in between two of the policy's looks still gets the whole grace after it leaves; the
   * Mac's list refreshes do not.
   */
  readonly answer = (request: RpcRequest, origin?: RequestOrigin): Promise<RpcReply> => {
    if (this.phase === "closing" || !this.core) return Promise.resolve({ type: "rpc.error", id: request.id, message: NOT_READY.closing });
    if (usesHost(request.method, origin)) this.awake?.touch();
    return this.core.handle(request, origin);
  };

  /** `ctl`'s requests: the status reads whatever the phase, the rest only when ready. */
  readonly request = async (request: BrainControlRequest): Promise<unknown> => {
    if (request.op === "status" || request.op === "wake") return this.status();
    if (this.phase === "closing") throw new Error(NOT_READY.closing);
    if (!this.ops) throw new Error(NOT_READY.starting);
    return this.ops(request);
  };

  busy(): string | null {
    return this.control?.busy ?? this.core?.busy() ?? null;
  }

  status(): BrainStatus {
    return { state: this.phase, version: this.version, pid: process.pid, since: this.since, busy: this.busy() };
  }

  /** Once. Sleeping stops the sandbox too; an idle sleep gives way when something became busy since the policy looked. */
  async shutdown(why: SleepReason | "stop"): Promise<void> {
    if (this.phase === "closing" || (why === "idle" && this.busy())) return;
    this.phase = "closing";
    this.awake?.stop();
    this.log.write("info", `Closing: ${why}.`);
    let code = 0;
    try {
      await this.core?.close();
    } catch (error) {
      this.log.write("error", `Closing the core failed: ${words(error)}`);
      code = FAILED;
    }
    // Last, so a waker asking how the brain is hears "closing" until the core is closed.
    await this.control?.close();
    if (why !== "stop") await this.self.stop().catch((error: unknown) => this.log.write("warn", `Could not stop the brain's sandbox: ${words(error)}`));
    process.exit(code);
  }
}

/**
 * The brain process: runs under the start command's lock, so at most one serves per machine. Prints the ready line once
 * phones and `ctl` can reach it. The start line, the key and handed-over values are never written anywhere.
 */
export async function serve(appDir: string): Promise<void> {
  const layout = brainLayout(path.resolve(appDir, "..", ".."));
  const version = path.basename(appDir);
  const log = new BrainLog(layout.log);
  const { start, secrets } = await boot(layout, log);
  const self = selfOf(start);
  const host = new Host(version, self, log);
  process.on("SIGTERM", () => void host.shutdown("stop"));
  process.on("SIGINT", () => void host.shutdown("stop"));
  try {
    host.control = await serveControl(layout.socket, host.request, () => host.awake?.touch());
    // Agent updates install where machine setup did, as the same user and never with sudo.
    process.env["NPM_CONFIG_PREFIX"] = layout.npm;
    const github = new BrainGitHub(secrets.store(GITHUB_CHANNEL), (text) => log.write("warn", text));
    await github.load();
    useGitHubSignIn(() => github.environment());
    const core = await OpenOrc.create(brainOptions({ layout, appDir, start, self, secrets, transport: log.transport(), runnerFiles: await runnerFiles(appDir) }));
    host.core = core;
    await retireSignedOut(core);
    await core.remote.attach(host.answer);
    const { listener } = await core.remote.configure(true);
    if (listener.state !== "on") throw new Error(`Phone access did not start: ${listener.state === "failed" ? listener.reason : "it is off"}.`);
    host.ops = controlHandlers({ core, key: start.key, layout, github, stop: () => void host.shutdown("stop"), answering: () => host.control?.busy === "control" });
    host.awake = new BrainAwake({ busy: () => host.busy(), self, sleep: (why) => host.shutdown(why), warn: (text) => log.write("warn", text) });
    host.phase = "ready";
    host.awake.start();
    log.write("info", `Ready: version ${version}, phones through ${start.address}, listening on ${listener.port}.`);
  } catch (error) {
    await host.core?.close().catch(() => undefined);
    exitWith(log, FAILED, `The brain could not start: ${words(error)}`);
  }
  process.stdout.write(`${BRAIN_READY} ${version}\n`);
}
