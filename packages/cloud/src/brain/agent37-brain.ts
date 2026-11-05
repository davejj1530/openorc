import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { AGENT37_SIZES } from "@openorc/protocol";
import { AGENT37_ENDPOINTS, Agent37Error, agent37Api, type Agent37Api, type Agent37Instance } from "../agent37.js";
import { Agent37Sandbox, OPENING, STATES, agent37HostOf, instanceServerSource, ready, shellQuote } from "../agent37-sandbox.js";
import type { InstanceProcess } from "../instance-port.js";
import { runnerFiles, type RunnerFile } from "../runner-client.js";
import type { SandboxExecResult, SandboxInfo } from "../sandbox.js";
import { BRAIN_PORT } from "./layout.js";
import type { BrainAccess, BrainCommand, BrainHome, BrainStartCommand, BrainVm } from "./machine.js";

/** The brain's instance. Agent37 does not keep names unique, so it is found by its tag. */
const BRAIN = { template: "agent37-base", name: "OpenOrc brain", tag: "brain", disk: 20 } as const;
/** Agent37's shortest: a brain keeps itself awake while used, and this is how soon it sleeps when nothing keeps it. */
const IDLE_SECONDS = 300;
/** Run by Agent37 at every boot, from the default user's home. */
const BOOT_HOOK = ".agent37/hooks/post-restart.sh";
/** The start line the boot hook starts the brain with. */
const START_VARIABLE = "OPENORC_BRAIN_START";
const WRITE_HOOK = 'mkdir -p "${1%/*}" && printf %s "$2" > "$1.part" && chmod 755 "$1.part" && mv "$1.part" "$1"';

type Line = { stream: "stdout" | "stderr"; data: string };

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return Promise.race([promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
}

/** A command through OpenOrc's server in the instance. Its output is kept from the start, so every reader and its wait see all of it. */
class PortCommand implements BrainCommand {
  private readonly lines: Line[] = [];
  private readonly readers = new Set<() => void>();
  private ended = false;
  private readonly exited: Promise<number | null>;

  constructor(private readonly proc: InstanceProcess) {
    const ends = (["stdout", "stderr"] as const).map((stream) => {
      proc[stream].setEncoding("utf8");
      proc[stream].on("data", (data: string) => {
        this.lines.push({ stream, data });
        this.wakeReaders();
      });
      return once(proc[stream], "end");
    });
    this.exited = Promise.all([proc.exited, ...ends]).then(([code]) => {
      this.ended = true;
      this.wakeReaders();
      return code;
    });
  }

  async wait(options: { signal?: AbortSignal } = {}) {
    this.closeOn(options.signal);
    const code = await untilAborted(this.exited, options.signal);
    if (code === null) throw new Error("The connection to the brain's instance closed before its command ended.");
    return { exitCode: code, stdout: async () => this.text("stdout"), stderr: async () => this.text("stderr") };
  }

  async *logs(options: { signal?: AbortSignal } = {}): AsyncIterable<Line> {
    const { signal } = options;
    this.closeOn(signal);
    signal?.addEventListener("abort", () => this.wakeReaders(), { once: true });
    for (let next = 0; ;) {
      if (signal?.aborted) return;
      const line = this.lines[next];
      if (line) {
        next += 1;
        yield line;
      } else if (this.ended) return;
      else await new Promise<void>((resolve) => this.readers.add(resolve));
    }
  }

  writeStdin(data: string): Promise<void> {
    return new Promise((resolve, reject) => this.proc.stdin.write(data, (error) => (error ? reject(error) : resolve())));
  }

  closeStdin(): Promise<void> {
    return new Promise((resolve) => this.proc.stdin.end(resolve));
  }

  /** Done with it, the caller drops the connection and the command runs on, as a brain once started must. */
  private closeOn(signal: AbortSignal | undefined): void {
    if (signal?.aborted) this.proc.close();
    else signal?.addEventListener("abort", () => this.proc.close(), { once: true });
  }

  private text(stream: Line["stream"]): string {
    return this.lines
      .filter((line) => line.stream === stream)
      .map((line) => line.data)
      .join("");
  }

  private wakeReaders(): void {
    for (const resolve of this.readers) resolve();
    this.readers.clear();
  }
}

/** A step run as root, as Agent37's exec answers it once it ended. */
function finished(result: SandboxExecResult): BrainCommand {
  const stdout = result.stdout.toString("utf8");
  const lines: Line[] = [
    { stream: "stdout", data: stdout },
    { stream: "stderr", data: result.stderr },
  ];
  return {
    wait: async () => ({ exitCode: result.code ?? 1, stdout: async () => stdout, stderr: async () => result.stderr }),
    logs: async function* () {
      for (const line of lines) if (line.data) yield line;
    },
    writeStdin: () => Promise.reject(new Error("A step run as root takes no input.")),
    closeStdin: async () => undefined,
  };
}

/**
 * Starts the brain at every boot from the line kept in the instance's env, exactly as a wake's start does, and returns
 * while it runs. A sleep keeps the brain's process, but a boot, as after a restart or a wake that could not restore,
 * does not.
 */
function bootHook({ cmd, args }: BrainStartCommand): string {
  return [
    "#!/bin/sh",
    `# OpenOrc's cloud brain, started again after a boot from the line in ${START_VARIABLE}.`,
    `test -n "$${START_VARIABLE}" || exit 0`,
    `printf '%s\\n' "$${START_VARIABLE}" | nohup ${[cmd, ...args].map(shellQuote).join(" ")} >/dev/null 2>&1 &`,
    "",
  ].join("\n");
}

/** The brain's instance as BrainMachine uses it: commands that take input through OpenOrc's server there, root's through Agent37's exec. */
export class Agent37BrainVm implements BrainVm {
  readonly cwd: string;
  readonly state: SandboxInfo["state"];
  readonly expiresAt: Date | undefined = undefined;
  private readonly sandbox: Agent37Sandbox;

  constructor(
    readonly instance: Agent37Instance,
    private readonly api: Agent37Api,
    serverSource: Buffer,
  ) {
    this.cwd = instance.mount_path;
    this.state = STATES[instance.status];
    this.sandbox = new Agent37Sandbox(BRAIN.name, instance, api, serverSource);
  }

  domain(port: number): string | null {
    return this.instance.public_ports.find((open) => open.port === port)?.url ?? null;
  }

  async runCommand({ cmd, args, cwd, sudo }: Parameters<BrainVm["runCommand"]>[0]): Promise<BrainCommand> {
    if (sudo) return finished(await this.sandbox.exec(cmd, args, { cwd, sudo: true }));
    return new PortCommand(await this.sandbox.process(cmd, args, { cwd }));
  }

  async writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void> {
    for (const file of files) await this.sandbox.writeFile(file.path, Buffer.from(file.content));
  }

  readFile(file: string): Promise<Uint8Array | null> {
    return this.sandbox.readFile(file);
  }

  delete(): Promise<void> {
    return this.api.remove(this.instance.id);
  }

  /** The boot hook and the line it starts the brain with, written again only when either changed since the last start. */
  async keep(start: BrainStartCommand & { line: string }): Promise<void> {
    const hook = bootHook(start);
    const digest = createHash("sha256").update(hook).update("\n").update(start.line).digest("hex");
    if (this.instance.metadata?.start === digest) return;
    const written = await this.sandbox.exec("sh", ["-c", WRITE_HOOK, "brain-hook", path.posix.join(this.cwd, BOOT_HOOK), hook], { cwd: this.cwd });
    if (written.code !== 0) throw new Error(`Could not write the brain's boot hook on its instance. ${written.stderr.trim()}`.trim());
    // Metadata is replaced whole, so the tag goes along.
    await this.api.edit(this.instance.id, { env: { [START_VARIABLE]: start.line }, metadata: { ...this.instance.metadata, openorc: BRAIN.tag, start: digest } });
  }
}

/** The instance, as Agent37 says it is now. */
async function current(api: Agent37Api, id: string): Promise<Agent37Instance> {
  const instance = await api.get(id);
  if (!instance) throw new Error("The Agent37 instance no longer exists.");
  return instance;
}

/** Phones dial the brain at its port's public URL, which needs no Agent37 key: the link's own keys guard it. */
async function withPublicPort(api: Agent37Api, instance: Agent37Instance): Promise<Agent37Instance> {
  if (instance.public_ports.some((open) => open.port === BRAIN_PORT)) return instance;
  try {
    await api.addPublicPort(instance.id, BRAIN_PORT, BRAIN.name);
  } catch (error) {
    // An earlier try opened it and its answer was lost.
    if (!(error instanceof Agent37Error && error.code === "public_port_exists")) throw error;
  }
  return current(api, instance.id);
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * The brain on Agent37: an instance of the account's, tagged as the brain, which sleeps when idle and wakes for any
 * request to its addresses. Its thread instances are the account's too, tagged with the brain as their host.
 */
export function agent37Home(access: Extract<BrainAccess, { service: "agent37" }>, files: RunnerFile[] = runnerFiles()): BrainHome<Agent37BrainVm> {
  const api = agent37Api(access.key, access.endpoints ?? AGENT37_ENDPOINTS);
  const serverSource = instanceServerSource(files);
  const ours = (instance: Agent37Instance) => instance.metadata?.openorc === BRAIN.tag || agent37HostOf(instance) === "brain";
  const find = async () => (await api.list()).find((instance) => instance.metadata?.openorc === BRAIN.tag && OPENING[instance.status] !== "gone") ?? null;
  // A sleeping instance wakes for a command; this one waits for the wake, so the commands after it find the instance up.
  const awake = async (instance: Agent37Instance) => {
    await ready(api, instance);
    await api.exec(instance.id, "true");
    return new Agent37BrainVm(await current(api, instance.id), api, serverSource);
  };
  return {
    secrets: [access.key],
    async open() {
      const found =
        (await find()) ??
        (await api.create({
          template: BRAIN.template,
          name: BRAIN.name,
          metadata: { openorc: BRAIN.tag },
          resources: { ...AGENT37_SIZES[0], disk: BRAIN.disk },
          auto_sleep: true,
          idle_timeout_seconds: IDLE_SECONDS,
          public_ports: [{ port: BRAIN_PORT, label: BRAIN.name }],
        }));
      return awake(await withPublicPort(api, found));
    },
    async get(resume) {
      const found = await find();
      if (!found) return null;
      return resume ? awake(found) : new Agent37BrainVm(found, api, serverSource);
    },
    launch: (brain, { threadSize }) => ({ vercel: null, agent37: { connection: { key: access.key, ...(threadSize ?? AGENT37_SIZES[0]) }, instance: brain.instance.id } }),
    keep: (brain, start) => brain.keep(start),
    /**
     * Agent37 reports spending by instance, so a thread instance deleted already counts no more: what it spent leaves
     * the sum with it.
     */
    async costSince(since, now) {
      const [instances, usage] = await Promise.all([api.list(), api.usage(day(since), day(now))]);
      const counted = new Set(instances.filter(ours).map((instance) => instance.id));
      return usage.reduce((sum, spent) => sum + (counted.has(spent.id) ? spent.total_micros : 0), 0) / 1e6;
    },
    async removeAll() {
      const instances = (await api.list()).filter(ours);
      const brains = instances.filter((instance) => instance.metadata?.openorc === BRAIN.tag);
      for (const instance of [...brains, ...instances.filter((each) => !brains.includes(each))]) await api.remove(instance.id);
    },
  };
}
