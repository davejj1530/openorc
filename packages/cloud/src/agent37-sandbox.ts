import { createHash } from "node:crypto";
import path from "node:path";
import { AGENT37_SIZES } from "@openorc/protocol";
import { setTimeout as sleep } from "node:timers/promises";
import { agent37Api, agent37Hourly, type Agent37Api, type Agent37Instance, type Agent37Status, type Agent37Usage } from "./agent37.js";
import { ensureDocker } from "./docker.js";
import { INSTANCE_SERVER_PORT, InstancePort, instanceServerAnswer, type InstanceProcess } from "./instance-port.js";
import type { RunnerFile } from "./runner-client.js";
import {
  SANDBOX_AWAY_MS,
  SANDBOX_PREFIX,
  type Sandbox,
  type SandboxCommandOptions,
  type SandboxExecResult,
  type SandboxInfo,
  type SandboxNeeds,
  type SandboxProvider,
  type SandboxStream,
} from "./sandbox.js";

/** The connection Settings keeps: the account's key, and the size new instances are made in. */
export interface Agent37Connection {
  key: string;
  /** With `memory`, one of AGENT37_SIZES. */
  cpu: 2 | 4;
  memory: 4 | 8 | 16 | 32;
}

/** The connection in `value`, or null unless it holds a key and one of Agent37's sizes. */
export function agent37Connection(value: unknown): Agent37Connection | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, cpu, memory } = value as Record<string, unknown>;
  const size = AGENT37_SIZES.find((entry) => entry.cpu === cpu && entry.memory === memory);
  return typeof key === "string" && key.trim() && size ? { key, cpu: size.cpu, memory: size.memory } : null;
}

const SERVER_FILE = "instance-server.ts";
/** The disk OpenOrc gives an instance, within the most each size allows (agent37.com/docs/agents-api/instance-sizing). */
const DISK_GB = 20;
const MOST_DISK_GB: Record<string, number> = { "2/4": 12, "4/8": 20, "4/16": 40, "4/32": 80 };

/** The disk for an instance of `size`: 20 GB, or the most its size allows when that is less. */
export function agent37Disk(size: { cpu: number; memory: number }): number {
  return Math.min(DISK_GB, MOST_DISK_GB[`${size.cpu}/${size.memory}`] ?? DISK_GB);
}
const MAX_IDLE_SECONDS = 86_400;
const POLL_MS = 1000;
const READY_TIMEOUT_MS = 5 * 60_000;
/** Agent37 says a server that just started may take a moment to answer at its address; this is how long it gets. */
const SERVER_START_MS = 60_000;
const SERVER_POLL_MS = 250;
/**
 * Ends any OpenOrc server already running in the instance, as one an older OpenOrc left on the port, before this one
 * starts. Matched by its command line, `node instance-server.ts --port <this instance's port>`: in an Agent37 instance
 * that is every one, and on a Mac running many stand-in instances, only this instance's. The shell running this never
 * matches.
 */
const STOP_OLD_SERVERS = `{ port="\${OPENORC_INSTANCE_PORT:-${INSTANCE_SERVER_PORT}}"; for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q "^node instance-server.ts --port $port " && kill "\${p#/proc/}" 2>/dev/null; done; sleep 0.5; true; }`;

/** Agent37 refuses an exec request over 128 KB; this leaves room for the JSON around the command. */
const COMMAND_LIMIT = 120 * 1024;
const USAGE_DAYS = 90;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** What opening an instance does in each state: use it, start it, wait for it to settle, or give up. */
export const OPENING: Record<Agent37Status, "ready" | "start" | "wait" | "failed" | "gone"> = {
  running: "ready",
  // The next command or request wakes it.
  sleeping: "ready",
  waking: "ready",
  stopped: "start",
  provisioning: "wait",
  starting: "wait",
  restarting: "wait",
  updating: "wait",
  stopping: "wait",
  failed: "failed",
  deleting: "gone",
  deleted: "gone",
};

export const STATES: Record<Agent37Status, SandboxInfo["state"]> = {
  provisioning: "starting",
  starting: "starting",
  restarting: "starting",
  updating: "starting",
  waking: "starting",
  running: "running",
  stopping: "stopping",
  deleting: "stopping",
  sleeping: "stopped",
  stopped: "stopped",
  deleted: "stopped",
  failed: "failed",
};

/** `word` as one POSIX shell word, whatever it holds. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** `cmd` and its arguments with `env` added, as shell words: Agent37 runs one command line and takes no environment. */
function commandWords(cmd: string, args: string[], env: Record<string, string> = {}): string {
  return ["env", ...Object.entries(env).map(([name, value]) => `${name}=${value}`), cmd, ...args].map(shellQuote).join(" ");
}

/** A VM instance, as Agent37 reports it or, should it not, as OpenOrc marked it when making it. */
function agent37Vm(instance: Agent37Instance): boolean {
  return instance.type === "vm" || instance.metadata?.type === "vm";
}

/** Waits out a change of state and starts a stopped instance, so commands can run in it. */
export async function ready(api: Agent37Api, first: Agent37Instance | null): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let instance = first;
  for (;;) {
    if (!instance) throw new Error("The Agent37 instance no longer exists.");
    const step = OPENING[instance.status];
    if (step === "ready") return;
    if (step === "start") return api.start(instance.id);
    if (step === "failed") throw new Error(`The Agent37 instance failed${instance.status_reason ? `: ${instance.status_reason.message}` : ""}. Delete it to start over.`);
    if (step === "gone") throw new Error("The Agent37 instance is being deleted.");
    if (Date.now() > deadline) throw new Error(`The Agent37 instance was still ${instance.status} after ${READY_TIMEOUT_MS / 60_000} minutes.`);
    await sleep(POLL_MS);
    instance = await api.get(instance.id);
  }
}

/**
 * An instance on Agent37. Commands run through Agent37's exec API; input streams and files go through OpenOrc's own
 * server in the instance, which the first such call starts. Files persist while it sleeps or stops.
 */
export class Agent37Sandbox implements Sandbox {
  /** The default user's home, such as /home/node. */
  readonly root: string;
  readonly awayMs = SANDBOX_AWAY_MS;
  private readonly id: string;
  private readonly server: InstancePort;
  private idleSeconds: number;
  /** Settles once the instance runs; null after `stop`, until the next call starts it again. */
  private running: Promise<void> | null = Promise.resolve();
  private serverStart: Promise<void> | null = null;
  /** Names this build of OpenOrc's server, so one an older OpenOrc left running is replaced. */
  private readonly build: string;
  /** On a VM instance only: the default type runs under gVisor, which cannot run a Docker daemon. */
  readonly startDocker?: () => Promise<void>;
  /** Docker being started; a second call waits for it. */
  private docker: Promise<void> | null = null;

  constructor(
    readonly name: string,
    instance: Agent37Instance,
    private readonly api: Agent37Api,
    private readonly serverSource: Buffer,
    private readonly serverStartMs = SERVER_START_MS,
  ) {
    this.id = instance.id;
    this.root = instance.mount_path;
    this.idleSeconds = instance.idle_timeout_seconds;
    this.build = createHash("sha256").update(serverSource).digest("hex").slice(0, 12);
    this.server = new InstancePort(api.port(instance.id, INSTANCE_SERVER_PORT), this.build);
    if (agent37Vm(instance))
      this.startDocker = () => {
        this.docker ??= ensureDocker(this).finally(() => (this.docker = null));
        return this.docker;
      };
  }

  private awake(): Promise<void> {
    this.running ??= this.api
      .get(this.id)
      .then((instance) => ready(this.api, instance))
      .catch((error: unknown) => {
        this.running = null;
        throw error;
      });
    return this.running;
  }

  async exec(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxExecResult> {
    await this.awake();
    const line = `cd ${shellQuote(options.cwd ?? this.root)} && exec ${commandWords(cmd, args, options.env)}`;
    const result = await this.api.exec(this.id, line, options.sudo ? { root: true } : {});
    if (result.truncated) throw new Error(`${cmd} printed more than Agent37 returns from one command, so its output was cut off.`);
    return { code: result.exit_code, stdout: Buffer.from(result.stdout, "utf8"), stderr: result.stderr };
  }

  async launch(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<void> {
    await this.awake();
    // Agent37 waits for a command's output to close, so this one hands it to /dev/null and returns while it runs on.
    const line = `cd ${shellQuote(options.cwd ?? this.root)} && (nohup ${commandWords(cmd, args, options.env)} </dev/null >/dev/null 2>&1 &)`;
    const result = await this.api.exec(this.id, line, options.sudo ? { root: true } : {});
    if (result.exit_code !== 0) throw new Error(`Could not start ${cmd} in the Agent37 instance. ${result.stderr.trim()}`.trim());
  }

  /** One command through OpenOrc's server, with its input, both of its outputs and its exit code. */
  async process(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<InstanceProcess> {
    const server = await this.serverUp();
    return server.process({ cmd, args, cwd: options.cwd ?? this.root, ...(options.env ? { env: options.env } : {}) });
  }

  async stream(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxStream> {
    const proc = await this.process(cmd, args, options);
    proc.stderr.resume();
    return {
      input: proc.stdin,
      output: proc.stdout,
      ended: proc.exited.then(() => undefined),
      close: () => {
        proc.kill("SIGKILL");
        proc.close();
      },
    };
  }

  async writeFile(file: string, content: Buffer): Promise<void> {
    await (await this.serverUp()).putFile(file, content);
  }

  async readFile(file: string): Promise<Buffer | null> {
    return (await this.serverUp()).getFile(file);
  }

  async keepAwake(forMs = this.awayMs): Promise<void> {
    await this.awake();
    const seconds = Math.min(MAX_IDLE_SECONDS, Math.ceil(forMs / 1000));
    if (seconds > this.idleSeconds) this.idleSeconds = (await this.api.edit(this.id, { idle_timeout_seconds: seconds })).idle_timeout_seconds;
    // A command is activity, which starts the instance's idle timer over.
    await this.api.exec(this.id, "true");
  }

  async stop(): Promise<void> {
    await this.api.stop(this.id);
    this.running = null;
  }

  private async serverUp(): Promise<InstancePort> {
    await this.awake();
    if (!(await this.server.health())) {
      this.serverStart ??= this.startServer().finally(() => (this.serverStart = null));
      await this.serverStart;
    }
    return this.server;
  }

  /** Writes OpenOrc's server into the instance and starts it, in one command, since nothing else moves files there yet. */
  private async startServer(): Promise<void> {
    const dir = path.posix.join(this.root, ".openorc", "instance");
    const file = path.posix.join(dir, SERVER_FILE);
    const log = path.posix.join(dir, "server.log");
    const line = [
      `mkdir -p ${shellQuote(dir)}`,
      `printf '%s' ${shellQuote(this.serverSource.toString("base64"))} | base64 -d > ${shellQuote(`${file}.part`)}`,
      `mv ${shellQuote(`${file}.part`)} ${shellQuote(file)}`,
      `echo '{"type":"module"}' > ${shellQuote(path.posix.join(dir, "package.json"))}`,
      `cd ${shellQuote(dir)}`,
      STOP_OLD_SERVERS,
      `(nohup node ${SERVER_FILE} --port "\${OPENORC_INSTANCE_PORT:-${INSTANCE_SERVER_PORT}}" --build ${this.build} </dev/null >${shellQuote(log)} 2>&1 &)`,
    ].join(" && ");
    if (line.length > COMMAND_LIMIT) throw new Error(`OpenOrc's server for Agent37 is too large to send in one command.`);
    const started = await this.api.exec(this.id, line);
    if (started.exit_code !== 0) throw new Error(`Could not start OpenOrc's server in the Agent37 instance. ${started.stderr.trim()}`.trim());
    const deadline = Date.now() + this.serverStartMs;
    for (let answer = await this.server.probe(); answer !== null; answer = await this.server.probe()) {
      if (Date.now() > deadline) throw new Error(await this.unreachable(answer, log));
      await sleep(SERVER_POLL_MS);
    }
  }

  /** Why the server's address does not answer: the server is down, or it runs and Agent37's address does not reach it. */
  private async unreachable(answer: string, log: string): Promise<string> {
    const port = `\${OPENORC_INSTANCE_PORT:-${INSTANCE_SERVER_PORT}}`;
    const inside = await this.api
      .exec(
        this.id,
        `node -e "fetch('http://127.0.0.1:'+process.argv[1]+'/openorc/health').then((r) => r.text()).then((t) => process.exit(t === process.argv[2] ? 0 : 1), () => process.exit(1))" "${port}" ${shellQuote(instanceServerAnswer(this.build))}`,
      )
      .catch(() => null);
    if (inside?.exit_code === 0) return `OpenOrc's server runs in the Agent37 instance, but Agent37's address for its port answered ${answer}.`;
    const output = await this.api.exec(this.id, `tail -n 20 ${shellQuote(log)}`).catch(() => null);
    return `OpenOrc's server in the Agent37 instance did not start (its address answered ${answer}). ${output?.stdout.trim() ?? ""}`.trim();
  }
}

/** OpenOrc's server for an instance, from the runner's files. */
export function instanceServerSource(files: RunnerFile[]): Buffer {
  const server = files.find((file) => file.name === SERVER_FILE);
  if (!server) throw new Error(`The runner's files lack ${SERVER_FILE}.`);
  return server.content;
}

/** Which OpenOrc makes and lists an account's thread instances: the Mac's, or its cloud brain's beside it. */
export type Agent37Host = "mac" | "brain";

/** The host a thread instance belongs to. Instances from before hosts were kept are the Mac's. */
export function agent37HostOf(instance: Agent37Instance): Agent37Host | null {
  if (instance.metadata?.openorc !== "thread") return null;
  return instance.metadata.host === "brain" ? "brain" : "mac";
}

export interface Agent37ProviderOptions {
  /** Null until Agent37 is connected. Read on every open, so a change in Settings applies to the next instance. */
  credentials: () => Promise<Agent37Connection | null>;
  /** The runner's files; OpenOrc's server for an instance is the one named instance-server.ts. */
  files: RunnerFile[];
  /** The Mac's unless given. Each host opens, lists and removes only its own instances. */
  host?: Agent37Host;
  api?: (key: string) => Agent37Api;
  /** How long a server just started gets to answer at its address; a minute unless given. */
  serverStartMs?: number;
}

type Ours = Agent37Instance & { name: string };

function info(instance: Ours, spent: Agent37Usage | undefined): SandboxInfo {
  const { compute } = agent37Hourly(instance.resources, agent37Vm(instance) ? "vm" : "default");
  return {
    name: instance.name,
    state: STATES[instance.status],
    createdAt: instance.created * 1000,
    // Agent37 does not say when a running instance woke.
    awakeSince: null,
    // It bills compute only while an instance runs, so its compute spending at the hourly rate is the time it ran.
    awakeMs: spent ? Math.round((spent.compute_micros / 1e6 / compute) * HOUR_MS) : 0,
    vcpus: instance.resources.cpu,
    memoryMb: instance.resources.memory * 1024,
    costUsd: (spent?.total_micros ?? 0) / 1e6,
  };
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

export class Agent37SandboxProvider implements SandboxProvider {
  readonly id = "agent37";
  private readonly api: (key: string) => Agent37Api;
  private readonly host: Agent37Host;
  /** Agent37 does not keep names unique, so opening one name twice at once must not make two instances. */
  private readonly opening = new Map<string, Promise<Agent37Sandbox>>();

  constructor(private readonly options: Agent37ProviderOptions) {
    this.api = options.api ?? ((key) => agent37Api(key));
    this.host = options.host ?? "mac";
  }

  /** A thread instance this host made, which leaves out the other host's and anything else on the account. */
  private ours(instance: Agent37Instance): instance is Ours {
    return !!instance.name?.startsWith(SANDBOX_PREFIX) && agent37HostOf(instance) === this.host && instance.status !== "deleted";
  }

  private async access(): Promise<{ api: Agent37Api; connection: Agent37Connection }> {
    const connection = agent37Connection(await this.options.credentials());
    if (!connection) throw new Error("Connect Agent37 in Settings to run in the cloud.");
    return { api: this.api(connection.key), connection };
  }

  open(name: string, needs: SandboxNeeds = {}): Promise<Agent37Sandbox> {
    const pending = this.opening.get(name);
    if (pending) return pending;
    const opening = this.openNow(name, needs).finally(() => this.opening.delete(name));
    this.opening.set(name, opening);
    return opening;
  }

  private async openNow(name: string, needs: SandboxNeeds): Promise<Agent37Sandbox> {
    const { api, connection } = await this.access();
    const found = (await api.list()).find((instance) => instance.name === name && this.ours(instance) && OPENING[instance.status] !== "gone");
    const instance =
      found ??
      (await api.create({
        template: "agent37-base",
        // Type and size apply when the instance is made; one that exists keeps what it was made with.
        ...(needs.docker ? { type: "vm" as const } : {}),
        name,
        metadata: { openorc: "thread", host: this.host, ...(needs.docker ? { type: "vm" } : {}) },
        resources: { cpu: connection.cpu, memory: connection.memory, disk: agent37Disk(connection) },
        // OpenOrc keeps the instance awake while an agent works; this is for when the Mac is away.
        auto_sleep: true,
        idle_timeout_seconds: SANDBOX_AWAY_MS / 1000,
      }));
    await ready(api, instance);
    return new Agent37Sandbox(name, instance, api, instanceServerSource(this.options.files), this.options.serverStartMs);
  }

  /** Deletes the named instance and its files for good, every one of this host's by that name. */
  async remove(name: string): Promise<void> {
    const { api } = await this.access();
    for (const instance of (await api.list()).filter((entry) => entry.name === name && this.ours(entry))) await api.remove(instance.id);
  }

  /** None until Agent37 is connected. Time awake and cost come from Agent37's usage over the last 90 days. */
  async list(): Promise<SandboxInfo[]> {
    const connection = agent37Connection(await this.options.credentials());
    if (!connection) return [];
    const api = this.api(connection.key);
    const now = Date.now();
    // A key that may not read usage still lists its instances, with nothing spent.
    const [instances, usage] = await Promise.all([api.list(), api.usage(day(now - (USAGE_DAYS - 1) * DAY_MS), day(now)).catch(() => [])]);
    const spent = new Map(usage.map((entry) => [entry.id, entry]));
    return instances.filter((instance) => this.ours(instance)).map((instance) => info(instance, spent.get(instance.id)));
  }

  /** Instances keep running when OpenOrc closes and sleep on their own. */
  async close(): Promise<void> {}
}
