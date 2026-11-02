import { PassThrough, Writable } from "node:stream";
import { APIError, Sandbox as SdkSandbox } from "@vercel/sandbox";
import { SANDBOX_AWAY_MS, SANDBOX_PREFIX, type Sandbox, type SandboxCommandOptions, type SandboxExecResult, type SandboxInfo, type SandboxProvider, type SandboxStream } from "./sandbox.js";

/** After the command exits, how long its remaining output gets to arrive before the stream ends anyway. */
const LOG_DRAIN_MS = 2000;

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** The connection Settings keeps: where sandboxes go, and how big new ones are. */
export interface VercelConnection extends VercelCredentials {
  /** vCPUs for new sandboxes, with 2 GB of memory each; Vercel's default when absent. */
  vcpus?: number;
}

/** Vercel's list prices for Sandbox on Pro, in its default region iad1 (vercel.com/docs/sandbox/pricing, 2026-11-02). */
const PRICE = { activeCpuHour: 0.128, memoryGbHour: 0.0212 } as const;
const HOUR_MS = 3_600_000;

/** A sandbox's cost at list prices: CPU only while it computes, memory for as long as it runs. Pro's monthly credit pays first. */
export function vercelSandboxCost(usage: { activeCpuMs: number; durationMs: number; memoryMb: number }): number {
  return (usage.activeCpuMs / HOUR_MS) * PRICE.activeCpuHour + (usage.memoryMb / 1024) * (usage.durationMs / HOUR_MS) * PRICE.memoryGbHour;
}

/** The parts of a listed Vercel sandbox the provider reports. */
export interface VercelListed {
  name: string;
  status: "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";
  createdAt: number;
  statusUpdatedAt?: number | undefined;
  vcpus?: number | undefined;
  memory?: number | undefined;
  totalActiveCpuDurationMs?: number | undefined;
  totalDurationMs?: number | undefined;
}

const STATES: Record<VercelListed["status"], SandboxInfo["state"]> = {
  pending: "starting",
  running: "running",
  stopping: "stopping",
  snapshotting: "stopping",
  stopped: "stopped",
  failed: "failed",
  aborted: "failed",
};

function info(listed: VercelListed): SandboxInfo {
  const running = listed.status === "running";
  const memoryMb = listed.memory ?? null;
  const awakeMs = listed.totalDurationMs ?? 0;
  return {
    name: listed.name,
    state: STATES[listed.status],
    createdAt: listed.createdAt,
    awakeSince: running ? (listed.statusUpdatedAt ?? null) : null,
    awakeMs,
    vcpus: listed.vcpus ?? null,
    memoryMb,
    costUsd: vercelSandboxCost({ activeCpuMs: listed.totalActiveCpuDurationMs ?? 0, durationMs: awakeMs, memoryMb: memoryMb ?? 0 }),
  };
}

/** The parts of a Vercel command this provider uses. */
export interface VercelCommand {
  wait(): Promise<{ exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> }>;
  logs(): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/** The parts of a Vercel sandbox this provider uses. Every command starts detached; `exec` waits for it. */
export interface VercelVm {
  runCommand(params: { cmd: string; args: string[]; cwd: string; env?: Record<string, string>; sudo?: boolean; detached: true; stdin?: boolean }): Promise<VercelCommand>;
  writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  /** Where the session's commands start, which depends on the sandbox's image. */
  readonly cwd: string;
  /** When the running session times out; undefined while none runs. */
  readonly expiresAt: Date | undefined;
  /** Moves the running session's timeout later by `duration`, up to the plan's longest session. */
  extendTimeout(duration: number): Promise<void>;
  stop(): Promise<unknown>;
}

export interface VercelOpenParams extends VercelCredentials {
  name: string;
  persistent: true;
  timeout: number;
  resources?: { vcpus: number };
  env?: Record<string, string>;
  onCreate: (vm: VercelVm) => Promise<void>;
}

/** How the provider reaches Vercel. Tests pass a stand-in; the app passes the SDK. */
export interface VercelApi {
  getOrCreate(params: VercelOpenParams): Promise<VercelVm>;
  /** Deletes the sandbox, its files and the snapshots only it used. */
  remove(params: VercelCredentials & { name: string }): Promise<void>;
  /** The project's sandboxes whose names start with `prefix`. */
  list(params: VercelCredentials & { prefix: string }): Promise<VercelListed[]>;
}

const sdk: VercelApi = {
  getOrCreate: async ({ onCreate, ...params }) => {
    const vm: VercelVm = await SdkSandbox.getOrCreate({ ...params, onCreate: (sandbox) => onCreate(sandbox) });
    return vm;
  },
  remove: async ({ name, token, teamId, projectId }) => {
    try {
      const sandbox = await SdkSandbox.get({ name, token, teamId, projectId });
      await sandbox.delete({ deleteOrphanSnapshots: true });
    } catch (error) {
      // Already gone, or never made: either way there is nothing left to delete.
      if (error instanceof APIError && error.response.status === 404) return;
      throw error;
    }
  },
  // Vercel takes a name prefix only when the list is sorted by name.
  list: async ({ prefix, token, teamId, projectId }) => (await SdkSandbox.list({ projectId, token, teamId, namePrefix: prefix, sortBy: "name" })).toArray(),
};

export interface VercelProviderOptions {
  /** Null until Vercel is connected. Read on every open, so a change in Settings applies to the next sandbox. */
  credentials: () => Promise<VercelConnection | null>;
  api?: VercelApi;
}

async function run(vm: VercelVm, cmd: string, args: string[], options: SandboxCommandOptions & { sudo?: boolean } = {}): Promise<SandboxExecResult> {
  const command = await vm.runCommand({ cmd, args, cwd: options.cwd ?? vm.cwd, ...(options.env ? { env: options.env } : {}), ...(options.sudo ? { sudo: true } : {}), detached: true });
  const done = await command.wait();
  return { code: done.exitCode, stdout: Buffer.from(await done.stdout(), "utf8"), stderr: await done.stderr() };
}

/** Puts Claude Code on the VM's PATH unless it is there already. */
export async function ensureClaude(vm: VercelVm): Promise<void> {
  // Plain sh, not a login shell: the runner starts the CLI with the VM's default environment.
  const found = await run(vm, "sh", ["-c", "command -v claude"]);
  if (found.code === 0) return;
  const install = await run(vm, "npm", ["install", "-g", "@anthropic-ai/claude-code"], { sudo: true });
  if (install.code !== 0) throw new Error(`Claude Code could not be installed in the cloud workspace: ${install.stderr.trim().slice(-500)}`);
}

/** A VM on Vercel. Its files persist between sessions; its processes do not. */
export class VercelSandbox implements Sandbox {
  /** The folder the image starts its sessions in, such as /vercel/sandbox; read once, since a stopped VM has none. */
  readonly root: string;
  /** The session timeout each sandbox is made with. */
  readonly awayMs = SANDBOX_AWAY_MS;

  constructor(
    readonly name: string,
    private readonly vm: VercelVm,
  ) {
    this.root = vm.cwd;
  }

  exec(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxExecResult> {
    return run(this.vm, cmd, args, { ...options, cwd: options.cwd ?? this.root });
  }

  async launch(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<void> {
    await this.vm.runCommand({ cmd, args, cwd: options.cwd ?? this.root, ...(options.env ? { env: options.env } : {}), detached: true });
  }

  async stream(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxStream> {
    const command = await this.vm.runCommand({ cmd, args, cwd: options.cwd ?? this.root, ...(options.env ? { env: options.env } : {}), detached: true, stdin: true });
    const output = new PassThrough();
    const pump = (async () => {
      for await (const line of command.logs()) if (line.stream === "stdout") output.write(Buffer.from(line.data, "utf8"));
    })();
    const exited = command.wait().then(() => Promise.race([pump, new Promise((resolve) => setTimeout(resolve, LOG_DRAIN_MS))]));
    const ended = Promise.race([pump, exited])
      .catch(() => undefined)
      .then(() => {
        output.end();
      });
    // Writable calls write once at a time, so input reaches the command in order.
    const input = new Writable({
      write: (chunk: Buffer, _encoding, done) => void command.writeStdin(chunk).then(() => done(), done),
      final: (done) => void command.closeStdin().then(() => done(), done),
    });
    return { input, output, ended, close: () => void command.kill("SIGKILL").catch(() => undefined) };
  }

  async writeFile(file: string, content: Buffer): Promise<void> {
    await this.vm.writeFiles([{ path: file, content }]);
  }

  readFile(file: string): Promise<Buffer | null> {
    return this.vm.readFileToBuffer({ path: file });
  }

  async keepAwake(): Promise<void> {
    const expires = this.vm.expiresAt?.getTime();
    const wanted = Date.now() + this.awayMs;
    if (expires !== undefined && expires >= wanted) return;
    await this.vm.extendTimeout(expires === undefined ? this.awayMs : wanted - expires);
  }

  async stop(): Promise<void> {
    await this.vm.stop();
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly id = "vercel";
  private readonly api: VercelApi;
  /** Sandboxes whose Claude Code was checked since the app started. */
  private readonly checked = new Set<string>();

  constructor(private readonly options: VercelProviderOptions) {
    this.api = options.api ?? sdk;
  }

  private async access(): Promise<VercelConnection> {
    const access = await this.options.credentials();
    if (!access?.token || !access.teamId || !access.projectId) throw new Error("Connect Vercel in Settings to run in the cloud.");
    return access;
  }

  /** Deletes a sandbox for good, with its files. */
  async remove(name: string): Promise<void> {
    const { token, teamId, projectId } = await this.access();
    await this.api.remove({ name, token, teamId, projectId });
    this.checked.delete(name);
  }

  /** None until Vercel is connected. */
  async list(): Promise<SandboxInfo[]> {
    const access = await this.options.credentials();
    if (!access) return [];
    const { token, teamId, projectId } = access;
    return (await this.api.list({ token, teamId, projectId, prefix: SANDBOX_PREFIX })).map(info);
  }

  async open(name: string): Promise<VercelSandbox> {
    const access = await this.access();
    let created = false;
    const vm = await this.api.getOrCreate({
      name,
      persistent: true,
      // Applies when the sandbox is made; one that exists keeps the size it was made with.
      ...(access.vcpus ? { resources: { vcpus: access.vcpus } } : {}),
      // OpenOrc keeps the session awake while an agent works and stops it once none does; this is for when the Mac is away.
      timeout: SANDBOX_AWAY_MS,
      token: access.token,
      teamId: access.teamId,
      projectId: access.projectId,
      onCreate: async (fresh) => {
        created = true;
        await ensureClaude(fresh);
      },
    });
    // A sandbox made before this check existed, or whose install failed, gets it on first use.
    if (!created && !this.checked.has(name)) await ensureClaude(vm);
    this.checked.add(name);
    return new VercelSandbox(name, vm);
  }

  /** VMs keep running when OpenOrc closes and sleep on their own. */
  async close(): Promise<void> {}
}
