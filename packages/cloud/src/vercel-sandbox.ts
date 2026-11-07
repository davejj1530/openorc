import { PassThrough, Writable } from "node:stream";
import { APIError, Sandbox as SdkSandbox, Snapshot as SdkSnapshot, type NetworkPolicy, type NetworkPolicyRule } from "@vercel/sandbox";
import { ensureDocker } from "./docker.js";
import {
  BrokeringUnavailable,
  SANDBOX_AWAY_MS,
  SANDBOX_PREFIX,
  BASE_PREFIX,
  type BrokeredHeader,
  type Sandbox,
  type SandboxBases,
  type SandboxCommandOptions,
  type SandboxExecResult,
  type SandboxInfo,
  type SandboxNeeds,
  type SandboxProvider,
  type SandboxStream,
} from "./sandbox.js";

/** After the command exits, how long its remaining output gets to arrive before the stream ends anyway. */
const LOG_DRAIN_MS = 2000;
/** How long a base's snapshot lasts unless replaced sooner. */
const BASE_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000;

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** The connection Settings keeps: where sandboxes go, and how big new ones are. */
export interface VercelConnection extends VercelCredentials {
  /** vCPUs for new sandboxes, with 2 GB of memory each; Vercel's default when absent. */
  vcpus?: number;
  /** Where new sandboxes run, such as sin1; Vercel's default, iad1, when absent. */
  region?: string;
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

export const STATES: Record<VercelListed["status"], SandboxInfo["state"]> = {
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
  /** Saves the files for new sandboxes to start from; the sandbox stops. An expiration of 0 keeps it for good. */
  snapshot(opts: { expiration: number }): Promise<{ snapshotId: string }>;
  /** Replaces the sandbox's network policy, on the running session first, then for later ones. */
  update(params: { networkPolicy: NetworkPolicy }): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface VercelOpenParams extends VercelCredentials {
  name: string;
  persistent: true;
  timeout: number;
  resources?: { vcpus: number };
  region?: string;
  env?: Record<string, string>;
  /** Where a sandbox being made starts: a base's snapshot. One that exists keeps its own files. */
  source?: { type: "snapshot"; snapshotId: string };
}

/** How the provider reaches Vercel. Tests pass a stand-in; the app passes the SDK. */
export interface VercelApi {
  getOrCreate(params: VercelOpenParams): Promise<VercelVm>;
  /** Deletes the sandbox, its files and, unless `keepSnapshots`, the snapshots only it used. */
  remove(params: VercelCredentials & { name: string; keepSnapshots?: boolean }): Promise<void>;
  /** Deletes a snapshot; one already gone changes nothing. */
  removeSnapshot(params: VercelCredentials & { snapshotId: string }): Promise<void>;
  /** The project's sandboxes whose names start with `prefix`. */
  list(params: VercelCredentials & { prefix: string }): Promise<VercelListed[]>;
}

const sdk: VercelApi = {
  getOrCreate: async ({ source, ...params }) => {
    const onCreate = async () => undefined;
    const vm: VercelVm = source ? await SdkSandbox.getOrCreate({ ...params, source, onCreate }) : await SdkSandbox.getOrCreate({ ...params, onCreate });
    return vm;
  },
  remove: async ({ name, token, teamId, projectId, keepSnapshots }) => {
    try {
      const sandbox = await SdkSandbox.get({ name, token, teamId, projectId });
      await sandbox.delete({ deleteOrphanSnapshots: !keepSnapshots });
    } catch (error) {
      // Already gone, or never made: either way there is nothing left to delete.
      if (error instanceof APIError && error.response.status === 404) return;
      throw error;
    }
  },
  removeSnapshot: async ({ snapshotId, token, teamId, projectId }) => {
    try {
      await (await SdkSnapshot.get({ snapshotId, token, teamId, projectId })).delete();
    } catch (error) {
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

async function run(vm: VercelVm, cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxExecResult> {
  const command = await vm.runCommand({ cmd, args, cwd: options.cwd ?? vm.cwd, ...(options.env ? { env: options.env } : {}), ...(options.sudo ? { sudo: true } : {}), detached: true });
  const done = await command.wait();
  return { code: done.exitCode, stdout: Buffer.from(await done.stdout(), "utf8"), stderr: await done.stderr() };
}

/**
 * The firewall rules for `headers`: each domain gets its headers set on the way out, and every other destination stays
 * open, so a turn reaches what it did before. With no headers the default open policy comes back, so a sign-in a
 * turn no longer needs does not linger.
 */
export function brokeringPolicy(headers: BrokeredHeader[]): NetworkPolicy {
  if (!headers.length) return "allow-all";
  const allow: Record<string, NetworkPolicyRule[]> = { "*": [] };
  for (const { domain, name, value } of headers) {
    const set = (allow[domain]?.[0]?.transform?.[0]?.headers ?? {}) as Record<string, string>;
    allow[domain] = [{ transform: [{ headers: { ...set, [name]: value } }] }];
  }
  return { allow };
}

/** A VM on Vercel. Its files persist between sessions; its processes do not. */
export class VercelSandbox implements Sandbox {
  /** The folder the image starts its sessions in, such as /vercel/sandbox; read once, since a stopped VM has none. */
  readonly root: string;
  /** The session timeout each sandbox is made with. */
  readonly awayMs = SANDBOX_AWAY_MS;
  /** Docker being started; a second call waits for it. */
  private docker: Promise<void> | null = null;

  constructor(
    readonly name: string,
    readonly vm: VercelVm,
  ) {
    this.root = vm.cwd;
  }

  exec(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxExecResult> {
    return run(this.vm, cmd, args, { ...options, cwd: options.cwd ?? this.root });
  }

  async launch(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<void> {
    await this.vm.runCommand({ cmd, args, cwd: options.cwd ?? this.root, ...(options.env ? { env: options.env } : {}), ...(options.sudo ? { sudo: true } : {}), detached: true });
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
    // Writable calls write once at a time, so input reaches the command in order. Input for a command that has exited
    // has nowhere to go, as on Agent37: failing the write would throw from a stream nobody listens to, and the runner
    // sends again what its command never acknowledged once it connects again.
    const input = new Writable({
      write: (chunk: Buffer, _encoding, done) => void command.writeStdin(chunk).then(() => done(), () => done()),
      final: (done) => void command.closeStdin().then(() => done(), () => done()),
    });
    return { input, output, ended, close: () => void command.kill("SIGKILL").catch(() => undefined) };
  }

  async writeFile(file: string, content: Buffer): Promise<void> {
    await this.vm.writeFiles([{ path: file, content }]);
  }

  readFile(file: string): Promise<Buffer | null> {
    return this.vm.readFileToBuffer({ path: file });
  }

  async keepAwake(forMs = this.awayMs): Promise<void> {
    const expires = this.vm.expiresAt?.getTime();
    const wanted = Date.now() + forMs;
    if (expires !== undefined && expires >= wanted) return;
    await this.vm.extendTimeout(expires === undefined ? forMs : wanted - expires);
  }

  async stop(): Promise<void> {
    await this.vm.stop();
  }

  /** Every Vercel VM has its own kernel, so Docker runs in any; its images stay with the files across sessions. */
  startDocker(): Promise<void> {
    this.docker ??= ensureDocker(this).finally(() => (this.docker = null));
    return this.docker;
  }

  async broker(headers: BrokeredHeader[]): Promise<void> {
    try {
      await this.vm.update({ networkPolicy: brokeringPolicy(headers) });
    } catch (error) {
      // Vercel adds headers on Pro and Enterprise only; a Hobby team's request is refused as forbidden or unpaid.
      if (headers.length && error instanceof APIError && (error.response.status === 402 || error.response.status === 403))
        throw new BrokeringUnavailable("This Vercel plan cannot add sign-ins outside the sandbox.");
      throw error;
    }
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly id = "vercel";
  private readonly api: VercelApi;

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
  }

  /** None until Vercel is connected. */
  async list(): Promise<SandboxInfo[]> {
    const access = await this.options.credentials();
    if (!access) return [];
    const { token, teamId, projectId } = access;
    // A base being made belongs to no conversation and goes once saved.
    return (await this.api.list({ token, teamId, projectId, prefix: SANDBOX_PREFIX })).filter((listed) => !listed.name.startsWith(BASE_PREFIX)).map(info);
  }

  async open(name: string, needs: SandboxNeeds = {}): Promise<VercelSandbox> {
    const access = await this.access();
    const vm = await this.api.getOrCreate({
      name,
      persistent: true,
      ...(needs.from ? { source: { type: "snapshot" as const, snapshotId: needs.from } } : {}),
      // Apply when the sandbox is made; one that exists keeps the size and region it was made with.
      ...(access.vcpus ? { resources: { vcpus: access.vcpus } } : {}),
      ...(access.region ? { region: access.region } : {}),
      // OpenOrc keeps the session awake while an agent works and stops it once none does; this is for when the Mac is away.
      timeout: SANDBOX_AWAY_MS,
      token: access.token,
      teamId: access.teamId,
      projectId: access.projectId,
    });
    return new VercelSandbox(name, vm);
  }

  /** VMs keep running when OpenOrc closes and sleep on their own. */
  async close(): Promise<void> {}

  /**
   * A base is a snapshot: the VM that made it is deleted once it is saved, and the snapshot kept. It lasts a fortnight
   * unless OpenOrc replaces it sooner, so one a project no longer uses goes on its own.
   */
  readonly bases: SandboxBases = {
    save: async (sandbox) => {
      if (!(sandbox instanceof VercelSandbox)) throw new Error("Only a sandbox this service made can become its base.");
      const { snapshotId } = await sandbox.vm.snapshot({ expiration: BASE_EXPIRATION_MS });
      const { token, teamId, projectId } = await this.access();
      await this.api.remove({ name: sandbox.name, token, teamId, projectId, keepSnapshots: true });
      return snapshotId;
    },
    remove: async (snapshotId) => {
      const { token, teamId, projectId } = await this.access();
      await this.api.removeSnapshot({ snapshotId, token, teamId, projectId });
    },
  };
}
