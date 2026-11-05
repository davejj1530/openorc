import path from "node:path";
import { APIError } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";
import type { SandboxInfo } from "../sandbox.js";
import { BRAIN_AWAY_MS, BRAIN_PORT } from "./layout.js";
import { vercelSandboxCost } from "../vercel-sandbox.js";
import {
  BrainMachine,
  BrainRefused,
  BrainUnavailable,
  brainVersionNewer,
  sessionShare,
  type BrainApi,
  type BrainCommand,
  type BrainOpenParams,
  type BrainSettings,
  type BrainVm,
  type SessionUsage,
} from "./machine.js";
import { billedSnapshots, snapshotStorageCost, type ListedSnapshot } from "./snapshot-storage.js";
import { brainKeyText, encodeControlReply, newBrainKey, parseLaunch, type BrainControlRequest, type BrainStatus } from "./wire.js";

const TOKEN = "vcp_brain_token_SECRET_value";
const CWD = "/vercel/sandbox";
const ROOT = `${CWD}/openorc-brain`;
const ADDRESS = "sb-abc123.vercel.run";
const bundle = (version: string) => ({ version, archive: Buffer.from(`archive of ${version}`) });

type Run = Parameters<BrainVm["runCommand"]>[0];
type Line = { stream: "stdout" | "stderr"; data: string };
type Output = { stdout?: string; stderr?: string };

const aborted = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));

/**
 * A command that exits when told to and counts the readers still waiting on it. Its output streams to every reader from
 * the start, as Vercel's logs do. Like the brain's scripts it acts on its one line, not on the close of its input.
 */
class FakeCommand implements BrainCommand {
  stdin = "";
  closed = false;
  /** When set, closing the input waits for it, as a slow round trip would. */
  closing: Promise<void> | null = null;
  waiting = 0;
  private readonly lines: Line[] = [];
  private readonly readers = new Set<() => void>();
  private code: number | null = null;
  private readonly exited: Promise<number>;
  private exit!: (code: number) => void;

  constructor(private readonly onLine?: (command: FakeCommand) => void) {
    this.exited = new Promise((resolve) => (this.exit = resolve));
  }

  emit(stream: Line["stream"], data: string): void {
    this.lines.push({ stream, data });
    this.wakeReaders();
  }

  finish(code: number, output: Output = {}): void {
    for (const stream of ["stdout", "stderr"] as const) if (output[stream]) this.lines.push({ stream, data: output[stream] });
    this.code = code;
    this.exit(code);
    this.wakeReaders();
  }

  async wait(options: { signal?: AbortSignal } = {}) {
    this.waiting += 1;
    try {
      const exitCode = await Promise.race([this.exited, aborted(options.signal)]);
      return { exitCode, stdout: async () => this.text("stdout"), stderr: async () => this.text("stderr") };
    } finally {
      this.waiting -= 1;
    }
  }

  async *logs(options: { signal?: AbortSignal } = {}): AsyncIterable<Line> {
    this.waiting += 1;
    options.signal?.addEventListener("abort", () => this.wakeReaders());
    try {
      for (let next = 0; ;) {
        if (options.signal?.aborted) return;
        const line = this.lines[next];
        if (line) {
          next += 1;
          yield line;
        } else if (this.code !== null) return;
        else await new Promise<void>((resolve) => this.readers.add(resolve));
      }
    } finally {
      this.waiting -= 1;
    }
  }

  async writeStdin(data: string): Promise<void> {
    const before = this.stdin;
    this.stdin += data;
    if (!before.includes("\n") && this.stdin.includes("\n")) this.onLine?.(this);
  }

  async closeStdin(): Promise<void> {
    this.closed = true;
    await this.closing;
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

const finished = (code: number, output: Output = {}) => {
  const command = new FakeCommand();
  command.finish(code, output);
  return command;
};

/** What each package installs, as the survey names it. */
const PROVIDES: Record<string, string> = {
  procps: "ps",
  "util-linux": "flock",
  git: "git",
  tar: "tar",
  gh: "gh",
  "@anthropic-ai/claude-code": "claude",
  "@openai/codex": "codex",
  "@opencode/cli": "opencode",
};
const NEEDS = ["node24", "ps", "flock", "git", "tar", "gh", "claude", "codex", "opencode"];

/** A Linux machine as the brain's steps see it. Every change it undergoes lands in `changes`. */
class FakeMachine {
  readonly has = new Set(["node24", "git", "tar"]);
  folders = false;
  readonly versions = new Map<string, string>();
  current: string | null = null;
  readonly files = new Map<string, Buffer>();
  readonly changes: string[] = [];
  readonly runs: Run[] = [];
  readonly starts: FakeCommand[] = [];
  /** Every command handed a line on its input: starts and control requests. */
  readonly fed: FakeCommand[] = [];
  /** When set, closing any command's input waits for it. */
  closing: Promise<void> | null = null;
  /** How a running brain answers status, one per ask, the last repeating; "gone" is no brain answering. */
  statuses: (BrainStatus["state"] | "gone")[] = [];
  /** Which status read each ask was: a poll, or a waker's that counts as use. */
  readonly reads: BrainControlRequest["op"][] = [];
  runningVersion = "brain-v1";
  answer: (request: BrainControlRequest) => Output & { code: number } = (request) => this.status(request);
  onStart: (command: FakeCommand) => void = () => undefined;

  private status(request: BrainControlRequest): Output & { code: number } {
    const state = (this.statuses.length > 1 ? this.statuses.shift() : this.statuses[0]) ?? "gone";
    if (request.op !== "status" && request.op !== "wake") return { code: 69 };
    this.reads.push(request.op);
    if (state === "gone") return { code: 69 };
    return { code: 0, stdout: `${encodeControlReply<"status">({ ok: true, result: { state, version: this.runningVersion, pid: 7, since: 1, busy: null } })}\n` };
  }

  private change(what: string, command: FakeCommand = finished(0)): FakeCommand {
    this.changes.push(what);
    return command;
  }

  run(params: Run): FakeCommand {
    this.runs.push(params);
    const fed = (command: FakeCommand) => {
      command.closing = this.closing;
      this.fed.push(command);
      return command;
    };
    const [, , label = "", ...args] = params.args;
    const steps: Record<string, () => FakeCommand> = {
      "brain-survey": () => {
        const [, app = ""] = args;
        const missing = NEEDS.filter((need) => !this.has.has(need)).concat(this.folders ? [] : ["folders"]);
        const installed = this.versions.get(path.posix.basename(app));
        const lines = [...missing.map((need) => `missing:${need}`), `current:${this.current ?? ""}`, ...(installed ? [`installed:${installed}`] : [])];
        return finished(0, { stdout: `${lines.join("\n")}\n` });
      },
      "brain-apt": () => {
        if (!params.sudo) return finished(100, { stderr: "E: Could not open lock file - are you root?" });
        for (const name of args) this.has.add(PROVIDES[name]!);
        return this.change(`apt ${args.join(" ")}`);
      },
      "brain-folders": () => {
        this.folders = true;
        return this.change(`folders ${args.join(" ")}`);
      },
      "brain-npm": () => {
        const [prefix, ...names] = args;
        if (params.sudo || prefix !== `${ROOT}/npm`) return finished(1, { stderr: "npm ERR! EACCES" });
        for (const name of names) this.has.add(PROVIDES[name]!);
        return this.change(`npm ${names.join(" ")}`);
      },
      "brain-unpack": () => {
        const [app = "", archive = "", sha = ""] = args;
        if (!this.files.delete(archive)) return finished(2, { stderr: "tar: cannot open" });
        this.versions.set(path.posix.basename(app), sha);
        return this.change(`unpack ${path.posix.basename(app)}`);
      },
      "brain-switch": () => {
        const [, version = "", ...keep] = args;
        this.current = version;
        for (const installed of [...this.versions.keys()]) if (installed !== version && !keep.includes(installed)) this.versions.delete(installed);
        return this.change(`switch ${version}`);
      },
      "brain-start": () => {
        const command = fed(new FakeCommand((started) => this.onStart(started)));
        this.starts.push(command);
        return command;
      },
      "brain-ctl": () =>
        fed(
          new FakeCommand((command) => {
            const { code, ...output } = this.answer(JSON.parse(command.stdin) as BrainControlRequest);
            command.finish(code, output);
          }),
        ),
    };
    return steps[label]?.() ?? finished(127, { stderr: `unknown step ${label}` });
  }
}

const projectId = (name: string) => (name === "openorc-brain" ? "prj_brain" : `prj_${name}`);

type FakeVm = Omit<BrainVm, "state"> & { state: SandboxInfo["state"]; updates: Partial<BrainSettings>[] };

/** Vercel with one team and project: sandboxes by name, all on one machine. */
class FakeVercel implements BrainApi {
  readonly sandboxes = new Map<string, FakeVm>();
  readonly opened: BrainOpenParams[] = [];
  readonly gets: { name: string; resume: boolean; projectId: string }[] = [];
  readonly deleted: { name: string; options: unknown }[] = [];
  readonly projects: string[] = [];
  /** The next command finds the sandbox stopped, though the look before it saw it running, as when it stops between. */
  stopsUnder = false;

  constructor(readonly machine = new FakeMachine()) {}

  add(name: string, settings: BrainSettings, state: SandboxInfo["state"] = "running"): FakeVm {
    const machine = this.machine;
    const vm: FakeVm = {
      cwd: CWD,
      state,
      expiresAt: new Date(Date.now() + 60_000),
      settings,
      updates: [],
      domain: (port) => (settings.ports.includes(port) ? `https://${ADDRESS}` : null),
      async update(changes) {
        this.updates.push(changes);
        Object.assign(settings, changes);
        machine.changes.push("update");
      },
      runCommand: async (params) => machine.run(params),
      writeFiles: async (files) => {
        for (const file of files) machine.files.set(file.path, Buffer.from(file.content));
        machine.changes.push(...files.map((file) => `write ${file.path}`));
      },
      readFile: async (file) => {
        machine.changes.push(`read ${file}`);
        return machine.files.get(file) ?? null;
      },
      delete: async (options) => {
        this.deleted.push({ name, options });
        this.sandboxes.delete(name);
      },
    };
    this.sandboxes.set(name, vm);
    return vm;
  }

  async project(_token: string, _teamId: string, name: string) {
    this.projects.push(name);
    return { id: projectId(name) };
  }

  async findProject(_token: string, _teamId: string, name: string) {
    return this.projects.includes(name) ? { id: projectId(name) } : null;
  }

  async open(params: BrainOpenParams) {
    this.opened.push(params);
    const { ports, timeout, snapshotExpiration, keepLastSnapshots } = params;
    const found = this.sandboxes.get(params.name);
    if (found) found.state = "running";
    return found ?? this.add(params.name, { ports, timeout, snapshotExpiration, keepLastSnapshots });
  }

  /** Its commands run in the session it found, and fail as Vercel's do once that has stopped. */
  async get({ name, resume, projectId }: { name: string; resume: boolean; projectId: string }) {
    this.gets.push({ name, resume, projectId });
    const vm = this.sandboxes.get(name) ?? null;
    if (!vm) return null;
    if (resume) vm.state = "running";
    const runCommand: BrainVm["runCommand"] = async (params) => {
      if (this.stopsUnder) vm.state = "stopped";
      this.stopsUnder = false;
      if (vm.state !== "running") throw new APIError(new Response(null, { status: 410 }));
      return vm.runCommand(params);
    };
    const readFile: BrainVm["readFile"] = async (file) => {
      if (vm.state !== "running") throw new APIError(new Response(null, { status: 410 }));
      return vm.readFile(file);
    };
    return Object.create(vm, { runCommand: { value: runCommand }, readFile: { value: readFile } }) as FakeVm;
  }

  async list() {
    return [...this.sandboxes.keys(), "openorc-gone-meanwhile"];
  }

  /** The sessions Vercel counted, and from when the brain last asked. */
  usage: SessionUsage[] = [];
  readonly asked: number[] = [];
  async sessions({ since }: { since: number }) {
    this.asked.push(since);
    return this.usage;
  }

  /** The project's snapshots as Vercel lists them, and those deleted by id. */
  kept: ListedSnapshot[] = [];
  readonly snapshotsDeleted: string[] = [];
  async snapshots() {
    return this.kept;
  }
  async deleteSnapshot({ id }: { id: string }) {
    this.snapshotsDeleted.push(id);
  }

  /** The project's snapshot storage on the bill and where the bill ends; null as for a token that may not read it. */
  billed: { usd: number; until: number } | null = null;
  async billedSnapshots() {
    return this.billed;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A snapshot of 1 GB unless told otherwise. */
const snapshot = (id: string, more: Partial<ListedSnapshot> & Pick<ListedSnapshot, "status">): ListedSnapshot => ({ id, sizeBytes: 1e9, createdAt: 0, ...more });

const connect = (vercel: FakeVercel, startMs = 2000) => BrainMachine.connect({ token: TOKEN, teamId: "team_1" }, { api: vercel, startMs, pollMs: 1 });
const labels = (runs: Run[]) => runs.map((run) => run.args[2]);

/** A brain provisioned with brain-v1 and every tool it needs, nothing running. */
async function provisioned() {
  const vercel = new FakeVercel();
  const brain = await connect(vercel);
  await brain.provision(bundle("brain-v1"));
  vercel.machine.runs.length = 0;
  vercel.machine.reads.length = 0;
  vercel.machine.fed.length = 0;
  return { vercel, brain, machine: vercel.machine };
}

describe("provisioning a brain", () => {
  it("makes the sandbox, sets up the machine and installs the bundle, and a second run writes nothing", async () => {
    const vercel = new FakeVercel();
    const brain = await connect(vercel);
    expect(vercel.projects).toEqual(["openorc-brain"]);
    expect(await brain.provision(bundle("brain-v1"), { region: "fra1" })).toEqual({ installed: "brain-v1", running: null });
    expect(vercel.opened[0]).toEqual({
      token: TOKEN,
      teamId: "team_1",
      projectId: "prj_brain",
      name: "brain",
      persistent: true,
      ports: [BRAIN_PORT],
      timeout: BRAIN_AWAY_MS,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 2, expiration: 0 },
      resources: { vcpus: 1 },
      region: "fra1",
    });
    const machine = vercel.machine;
    expect(machine.changes).toEqual([
      "apt procps util-linux gh",
      `folders ${ROOT} ${ROOT}/app ${ROOT}/data ${ROOT}/run ${ROOT}/logs ${ROOT}/npm ${ROOT}/inbox ${ROOT}/outbox`,
      "npm @anthropic-ai/claude-code @openai/codex @opencode/cli",
      `write ${ROOT}/inbox/brain-brain-v1.tgz`,
      "unpack brain-v1",
      "switch brain-v1",
    ]);
    expect(machine.current).toBe("brain-v1");

    const before = [...machine.changes];
    machine.runs.length = 0;
    expect(await brain.provision(bundle("brain-v1"))).toEqual({ installed: "brain-v1", running: null });
    expect(machine.changes).toEqual(before);
    expect(labels(machine.runs)).toEqual(["brain-survey", "brain-ctl"]);
  });

  it("looks for Claude, Codex and OpenCode in the brain's own npm folder", async () => {
    const vercel = new FakeVercel();
    const brain = await connect(vercel);
    await brain.provision(bundle("brain-v1"), { region: "fra1" });
    const survey = vercel.machine.runs.find((run) => run.args[2] === "brain-survey")!.args[1];
    for (const bin of ["claude", "codex", "opencode"]) expect(survey).toContain(`"$npm/bin/${bin}" --version`);
  });

  it("gives a brain made before the snapshot policy that policy, once", async () => {
    const vercel = new FakeVercel();
    vercel.add("brain", { ports: [BRAIN_PORT], timeout: BRAIN_AWAY_MS, snapshotExpiration: undefined, keepLastSnapshots: undefined });
    const brain = await connect(vercel);
    await brain.provision(bundle("brain-v1"));
    await brain.provision(bundle("brain-v1"));
    expect(vercel.sandboxes.get("brain")!.updates).toEqual([{ snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0 } }]);
  });

  it("switches to a new version and keeps the one before it and the one running, dropping the rest", async () => {
    const { vercel, brain, machine } = await provisioned();
    await brain.provision(bundle("brain-v2"));
    machine.statuses = ["ready"];
    machine.runningVersion = "brain-v1";
    expect(await brain.provision(bundle("brain-v3"))).toEqual({ installed: "brain-v3", running: "brain-v1" });
    expect([...machine.versions.keys()].sort()).toEqual(["brain-v1", "brain-v2", "brain-v3"]);
    await brain.provision(bundle("brain-v4"));
    expect(machine.current).toBe("brain-v4");
    expect([...machine.versions.keys()].sort()).toEqual(["brain-v1", "brain-v3", "brain-v4"]);
    expect(vercel.opened).toHaveLength(4);
    // Asked as use, so a running brain does not fall asleep under the upload.
    expect(machine.reads).toEqual(["wake", "wake", "wake"]);
  });

  it("points current at an installed version again without uploading it", async () => {
    const { brain, machine } = await provisioned();
    await brain.provision(bundle("brain-v2"));
    machine.current = "brain-v1";
    const before = machine.changes.length;
    await brain.provision(bundle("brain-v2"));
    expect(machine.changes.slice(before)).toEqual(["switch brain-v2"]);
  });

  it("never installs a bundle built before the installed one, and says which one the machine keeps", async () => {
    const vercel = new FakeVercel();
    const brain = await connect(vercel);
    await brain.provision(bundle("20261102120000-bbbbbbbbbbbb"));
    const before = [...vercel.machine.changes];
    expect(await brain.provision(bundle("20261101120000-aaaaaaaaaaaa"))).toEqual({ installed: "20261102120000-bbbbbbbbbbbb", running: null });
    expect(await brain.provision(bundle("3f2a9c1d00ab"))).toEqual({ installed: "20261102120000-bbbbbbbbbbbb", running: null });
    expect(vercel.machine.changes).toEqual(before);
    expect(vercel.machine.current).toBe("20261102120000-bbbbbbbbbbbb");
    expect(await brain.provision(bundle("20261103120000-cccccccccccc"))).toEqual({ installed: "20261103120000-cccccccccccc", running: null });
    expect(vercel.machine.current).toBe("20261103120000-cccccccccccc");
  });

  it("stops before changing anything when the image has no Node 24, and refuses a version that is not a folder name", async () => {
    const vercel = new FakeVercel();
    vercel.machine.has.delete("node24");
    const brain = await connect(vercel);
    await expect(brain.provision(bundle("brain-v1"))).rejects.toThrow("The brain's sandbox has no Node 24 or newer.");
    expect(vercel.machine.changes).toEqual([]);
    for (const version of ["current", "../escape", "1.0.partial", ""]) await expect(brain.provision(bundle(version))).rejects.toThrow("A brain bundle's version");
    expect(vercel.opened).toHaveLength(1);
  });
});

describe("brain versions", () => {
  it("are newer when built later from other contents, and one from before builds were dated comes first", () => {
    const cases: [string, string, boolean][] = [
      ["20261102120000-bbbbbbbbbbbb", "20261101120000-aaaaaaaaaaaa", true],
      ["20261101120000-aaaaaaaaaaaa", "20261102120000-bbbbbbbbbbbb", false],
      ["20261101120000-aaaaaaaaaaaa", "eed2a8309f9a", true],
      ["eed2a8309f9a", "20261101120000-aaaaaaaaaaaa", false],
      // A rebuild of the same contents is no update, and two undated ones cannot be told apart.
      ["20261103120000-aaaaaaaaaaaa", "20261101120000-aaaaaaaaaaaa", false],
      ["eed2a8309f9a", "3f2a9c1d00ab", false],
      ["3f2a9c1d00ab", "eed2a8309f9a", false],
    ];
    for (const [version, than, newer] of cases) expect([version, than, brainVersionNewer(version, than)]).toEqual([version, than, newer]);
  });
});

describe("waking a brain", () => {
  it("hands the start over on stdin only and returns once the brain prints its ready line", async () => {
    const { vercel, brain, machine } = await provisioned();
    machine.onStart = (command) => {
      command.emit("stderr", "loading\n");
      command.emit("stdout", "openorc-brain re");
      command.emit("stdout", "ady brain-v1\nlistening\n");
    };
    const key = newBrainKey();
    expect(await brain.wake({ key, name: "Cloud", threadVcpus: 4 })).toEqual({ state: "ready", address: ADDRESS, version: "brain-v1" });
    expect(vercel.gets.at(-1)).toEqual({ name: "brain", resume: true, projectId: "prj_brain" });

    const run = machine.runs.find((each) => each.args[2] === "brain-start")!;
    expect(run).toMatchObject({ cmd: "sh", cwd: CWD, detached: true, stdin: true });
    expect(run.args.slice(3)).toEqual([ROOT, `${ROOT}/app/current/brain.mjs`, `${ROOT}/run/brain.lock`]);
    expect(JSON.stringify(run)).not.toContain(brainKeyText(key));
    expect(JSON.stringify(run)).not.toContain(TOKEN);

    const [started] = machine.starts;
    expect(started!.stdin.endsWith("\n")).toBe(true);
    const sent = parseLaunch(started!.stdin.trim());
    expect(brainKeyText(sent.key)).toBe(brainKeyText(key));
    expect({ ...sent, key: null }).toEqual({
      key: null,
      name: "Cloud",
      address: ADDRESS,
      port: BRAIN_PORT,
      vercel: { connection: { token: TOKEN, teamId: "team_1", projectId: "prj_brain", vcpus: 4 }, sandbox: "brain" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started!.waiting).toBe(0);
  });

  it("acts on the brain's answer without waiting for a command's input to close, and still closes it", async () => {
    const { brain, machine } = await provisioned();
    machine.closing = new Promise<void>(() => undefined);
    machine.onStart = (command) => command.emit("stdout", "openorc-brain ready brain-v1\n");
    expect(await brain.wake({ key: newBrainKey(), name: "Cloud" })).toEqual({ state: "ready", address: ADDRESS, version: "brain-v1" });
    machine.statuses = ["ready"];
    expect(await brain.control({ op: "status" })).toMatchObject({ state: "ready", version: "brain-v1" });
    expect(machine.fed.map((command) => command.closed)).toEqual([true, true]);
  });

  it("reports a brain already running as ready, by its own status asked as use, so it stays up for the caller", async () => {
    const { brain, machine } = await provisioned();
    machine.onStart = (command) => command.finish(75);
    machine.statuses = ["ready"];
    machine.runningVersion = "brain-v0";
    expect(await brain.wake({ key: newBrainKey(), name: "Cloud" })).toEqual({ state: "ready", address: ADDRESS, version: "brain-v0" });
    expect(machine.starts).toHaveLength(1);
    expect(machine.reads).toEqual(["wake"]);
  });

  it("waits for a brain that is starting until it is ready", async () => {
    const { brain, machine } = await provisioned();
    machine.onStart = (command) => command.finish(75);
    machine.statuses = ["starting", "starting", "ready"];
    expect(await brain.wake({ key: newBrainKey(), name: "Cloud" })).toEqual({ state: "ready", address: ADDRESS, version: "brain-v1" });
    expect(labels(machine.runs).filter((label) => label === "brain-ctl")).toHaveLength(3);
  });

  it("starts the brain again once one that was closing has exited", async () => {
    const { brain, machine } = await provisioned();
    machine.onStart = (command) => (machine.starts.length === 1 ? command.finish(75) : command.emit("stdout", "openorc-brain ready brain-v1\n"));
    machine.statuses = ["closing", "closing", "gone"];
    expect(await brain.wake({ key: newBrainKey(), name: "Cloud" })).toEqual({ state: "ready", address: ADDRESS, version: "brain-v1" });
    expect(machine.starts).toHaveLength(2);
  });

  it("resumes and starts again when a brain sleeping as the wake lands stops its sandbox under a step", async () => {
    const { vercel, brain, machine } = await provisioned();
    const vm = vercel.sandboxes.get("brain")!;
    const stopping = () => {
      vm.state = "stopped";
      return new APIError(new Response(null, { status: 422 }), { json: { error: { code: "sandbox_stopping" } } });
    };
    const ready = (command: FakeCommand) => command.emit("stdout", "openorc-brain ready brain-v1\n");
    const sleeps: Record<string, () => void> = {
      "the start went down with its sandbox": () => {
        machine.onStart = (command) => {
          machine.onStart = ready;
          stopping();
          command.finish(143);
        };
      },
      "the start's line was refused": () => {
        machine.onStart = () => {
          machine.onStart = ready;
          throw stopping();
        };
      },
      "the waker's status was refused while the brain closed": () => {
        machine.onStart = (command) => {
          machine.onStart = ready;
          command.finish(75);
        };
        machine.answer = () => {
          machine.answer = () => ({ code: 69 });
          throw stopping();
        };
      },
    };
    for (const [sleep, arrange] of Object.entries(sleeps)) {
      arrange();
      const resumes = vercel.gets.filter((get) => get.resume).length;
      expect([sleep, await brain.wake({ key: newBrainKey(), name: "Cloud" })]).toEqual([sleep, { state: "ready", address: ADDRESS, version: "brain-v1" }]);
      expect(vercel.gets.filter((get) => get.resume).length - resumes).toBe(2);
    }
  });

  it("maps the brain's exits: a wrong key, a missing install, and anything else with its redacted error", async () => {
    const { brain, machine } = await provisioned();
    const key = newBrainKey();
    const outcomes: [number, string, unknown][] = [
      [77, "", { state: "wrong-key" }],
      [78, "", { state: "needs-provision", detail: "No brain is installed on its sandbox." }],
      [78, "missing: ps, flock\n", { state: "needs-provision", detail: "missing: ps, flock" }],
      [64, "", { state: "failed", detail: "The brain could not read its start line." }],
      [1, `Error: Vercel refused ${TOKEN}\nkey was ${brainKeyText(key)}\n`, { state: "failed", detail: "Error: Vercel refused [redacted]\nkey was [redacted]" }],
      [9, "", { state: "failed", detail: "The brain exited with 9." }],
    ];
    for (const [code, stderr, result] of outcomes) {
      machine.onStart = (command) => command.finish(code, { stderr });
      expect(await brain.wake({ key, name: "Cloud" })).toEqual(result);
    }
  });

  it("gives up on a brain that never gets ready, leaving nothing waiting on it", async () => {
    const vercel = new FakeVercel();
    await (await connect(vercel)).provision(bundle("brain-v1"));
    const brain = await connect(vercel, 30);
    expect(await brain.wake({ key: newBrainKey(), name: "Cloud" })).toEqual({ state: "failed", detail: "The brain did not start in time." });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(vercel.machine.starts[0]!.waiting).toBe(0);
  });

  it("asks for provisioning when there is no sandbox, or it does not open the brain's port", async () => {
    const empty = new FakeVercel();
    expect(await (await connect(empty)).wake({ key: newBrainKey(), name: "Cloud" })).toEqual({ state: "needs-provision", detail: "The brain's sandbox does not exist." });
    const portless = new FakeVercel();
    portless.add("brain", { ports: [], timeout: BRAIN_AWAY_MS, snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0 } });
    expect(await (await connect(portless)).wake({ key: newBrainKey(), name: "Cloud" })).toMatchObject({ state: "needs-provision" });
    expect(portless.machine.runs).toEqual([]);
  });
});

describe("what a brain costs", () => {
  it("prices the sessions Vercel counted since the month began at its list prices, asking Vercel and no sandbox", async () => {
    const { vercel, brain, machine } = await provisioned();
    vercel.usage = [
      { activeCpuMs: 3_600_000, durationMs: 7_200_000, memoryMb: 2048 },
      { activeCpuMs: 600_000, durationMs: 1_800_000, memoryMb: 4096 },
    ];
    const since = Date.UTC(2026, 10, 1);
    const cost = await brain.costSince(since);
    expect(cost).toBeCloseTo(vercelSandboxCost(vercel.usage[0]!) + vercelSandboxCost(vercel.usage[1]!), 10);
    expect(cost).toBeGreaterThan(0.2);
    expect(vercel.asked).toEqual([since]);
    expect(machine.runs).toEqual([]);
  });

  it("adds what the project's snapshots cost to keep this month: the days Vercel billed as billed, the hours since from its list", async () => {
    const { vercel, brain } = await provisioned();
    const since = Date.UTC(2026, 10, 1);
    vercel.kept = [snapshot("snap_brain", { status: "created", sizeBytes: 1e9, createdAt: since - DAY })];
    expect(await brain.costSince(since, since + 730 * HOUR)).toBeCloseTo(0.08, 10);
    vercel.billed = { usd: 0.5, until: since + 365 * HOUR };
    expect(await brain.costSince(since, since + 730 * HOUR)).toBeCloseTo(0.5 + 0.04, 10);
  });

  it("reads one project's snapshot storage from a team's daily charges, for the part of each day in the month", () => {
    const since = Date.parse("2026-11-01T00:00:00Z");
    const day = (start: string, end: string, quantity: number, more: object = {}) =>
      JSON.stringify({
        ChargePeriodStart: start,
        ChargePeriodEnd: end,
        ServiceName: "Snapshot Storage",
        ConsumedQuantity: quantity,
        ConsumedUnit: "gigabyte",
        Tags: { ProjectId: "prj_brain" },
        ...more,
      });
    const jsonl = [
      day("2026-10-31T08:00:00.000Z", "2026-11-01T08:00:00.000Z", 3),
      day("2026-11-01T08:00:00.000Z", "2026-11-02T08:00:00.000Z", 2),
      day("2026-11-01T08:00:00.000Z", "2026-11-02T08:00:00.000Z", 50, { Tags: { ProjectId: "prj_other" } }),
      day("2026-11-01T08:00:00.000Z", "2026-11-02T08:00:00.000Z", 50, { Tags: { ProjectId: "prj_brain_too" } }),
      day("2026-11-01T08:00:00.000Z", "2026-11-02T08:00:00.000Z", 50, { ServiceName: "Drive Storage" }),
      day("2026-11-02T08:00:00.000Z", "2026-11-03T08:00:00.000Z", 0),
      "",
    ].join("\n");
    const billed = billedSnapshots(jsonl, "prj_brain", since);
    expect(billed.until).toBe(Date.parse("2026-11-03T08:00:00Z"));
    expect(billed.usd).toBeCloseTo(((3 * 8 + 2 * 24) / 730) * 0.08, 10);
    expect(billedSnapshots("", "prj_brain", since)).toEqual({ usd: 0, until: since });
  });

  it("keeps each snapshot from the month's start or its making until now, or until the one that replaced it", () => {
    const since = 100 * DAY;
    const now = since + 10 * DAY;
    const gbDay = 0.08 / (730 / 24);
    // The brain keeps its last two: each snapshot went when the one two sessions later was made.
    const chain = [
      snapshot("a", { status: "deleted", createdAt: since - DAY, lastUsedAt: since - DAY + 1 }),
      snapshot("b", { status: "deleted", parentId: "a", createdAt: since + DAY, lastUsedAt: since + DAY + 1 }),
      snapshot("c", { status: "created", parentId: "b", createdAt: since + 3 * DAY }),
      snapshot("d", { status: "created", parentId: "c", createdAt: since + 6 * DAY }),
    ];
    expect(snapshotStorageCost(chain, since, now)).toBeCloseTo((3 + 5 + 7 + 4) * gbDay, 10);
    // Deleted with its sandbox: kept at least until its child, else its last use; one that failed never counts.
    expect(
      snapshotStorageCost(
        [snapshot("e", { status: "deleted", createdAt: since, lastUsedAt: since + DAY }), snapshot("f", { status: "deleted", parentId: "e", createdAt: since + 2 * DAY, lastUsedAt: since + 2 * DAY })],
        since,
        now,
      ),
    ).toBeCloseTo(2 * gbDay, 10);
    expect(snapshotStorageCost([snapshot("g", { status: "failed", createdAt: since })], since, now)).toBe(0);
    // An expiry ends it; one made before the month counts from the month's start.
    expect(snapshotStorageCost([snapshot("h", { status: "created", createdAt: since - 5 * DAY, expiresAt: since + 4 * DAY })], since, now)).toBeCloseTo(4 * gbDay, 10);
  });

  it("counts the share of a session that ran across the month's start, and none of one that ended before it", () => {
    const since = 1_000_000;
    expect(sessionShare({ createdAt: 0, startedAt: since - 1000, stoppedAt: since + 3000, activeCpuDurationMs: 400, memory: 2048 }, since, since + 10_000)).toEqual({
      activeCpuMs: 300,
      durationMs: 3000,
      memoryMb: 2048,
    });
    expect(sessionShare({ createdAt: 0, startedAt: since - 5000, stoppedAt: since - 1, activeCpuDurationMs: 400, memory: 2048 }, since, since + 10_000)).toBeNull();
    expect(sessionShare({ createdAt: 0, startedAt: since + 1000, activeCpuDurationMs: 50, memory: 2048 }, since, since + 5000)).toEqual({ activeCpuMs: 50, durationMs: 4000, memoryMb: 2048 });
  });
});

describe("asking and removing a brain", () => {
  it("answers a control request from the running brain, without waking a sleeping one", async () => {
    const { vercel, brain, machine } = await provisioned();
    machine.answer = (request) =>
      request.op === "pair" ? { code: 0, stdout: `log line\n${encodeControlReply<"pair">({ ok: true, result: { url: "openorc://pair#v1.x", expiresAt: 5 } })}\n` } : { code: 69 };
    expect(await brain.control({ op: "pair" })).toEqual({ url: "openorc://pair#v1.x", expiresAt: 5 });
    const ctl = machine.runs.find((run) => run.args[2] === "brain-ctl")!;
    expect(ctl.args.slice(3)).toEqual([`${ROOT}/app/current/ctl.mjs`]);

    await expect(brain.control({ op: "stop" })).rejects.toThrow(BrainUnavailable);
    const refusal = (error: string) => `${encodeControlReply<"pair">({ ok: false, error })}\n`;
    const failure = () => brain.control({ op: "pair" }).then(null, (error: Error) => [error instanceof BrainRefused, error.message]);
    machine.answer = () => ({ code: 0, stdout: refusal("Phone access is off.") });
    expect(await failure()).toEqual([true, "Phone access is off."]);
    machine.answer = () => ({ code: 1, stdout: refusal("The brain did not answer pair.") });
    expect(await failure()).toEqual([false, "The brain did not answer pair."]);

    vercel.sandboxes.get("brain")!.state = "stopped";
    machine.runs.length = 0;
    await expect(brain.control({ op: "status" })).rejects.toThrow(BrainUnavailable);
    expect(machine.runs).toEqual([]);
    expect(await brain.status()).toEqual({ state: "stopped", address: ADDRESS, expiresAt: expect.any(Number) });
    expect(vercel.gets.slice(-2).map((get) => get.resume)).toEqual([false, false]);
    expect(vercel.sandboxes.get("brain")!.state).toBe("stopped");
  });

  it("never wakes a brain that stops as it is asked, and says it is not running", async () => {
    const { vercel, brain, machine } = await provisioned();
    vercel.stopsUnder = true;
    await expect(brain.control({ op: "status" })).rejects.toThrow(BrainUnavailable);
    expect(vercel.sandboxes.get("brain")!.state).toBe("stopped");
    expect(machine.runs).toEqual([]);

    vercel.sandboxes.get("brain")!.state = "running";
    vercel.stopsUnder = true;
    machine.onStart = (command) => command.emit("stdout", "openorc-brain ready brain-v1\n");
    expect(await brain.wake({ key: newBrainKey(), name: "Cloud" })).toEqual({ state: "ready", address: ADDRESS, version: "brain-v1" });
  });

  it("reports a missing brain without making one", async () => {
    const vercel = new FakeVercel();
    expect(await (await connect(vercel)).status()).toEqual({ state: "missing", address: null, expiresAt: null });
    expect(vercel.sandboxes.size).toBe(0);
  });

  it("finds no brain in a team without its project, and makes none", async () => {
    const vercel = new FakeVercel();
    const find = () => BrainMachine.find({ token: TOKEN, teamId: "team_1" }, { api: vercel });
    expect(await find()).toBeNull();
    expect(vercel.projects).toEqual([]);
    await connect(vercel);
    expect(await (await find())!.status()).toEqual({ state: "missing", address: null, expiresAt: null });
    expect(vercel.projects).toEqual(["openorc-brain"]);
  });

  it("uploads a project's bundle to the running brain's inbox and has it imported there, never waking a sleeping one", async () => {
    const { vercel, brain, machine } = await provisioned();
    const heard: BrainControlRequest[] = [];
    machine.answer = (request) => {
      heard.push(request);
      if (request.op !== "import-project") return { code: 69 };
      const uploaded = machine.files.get(`${ROOT}/inbox/${request.bundle}`);
      if (uploaded?.toString() !== "git bundle bytes") return { code: 0, stdout: `${encodeControlReply<"import-project">({ ok: false, error: "No such bundle." })}\n` };
      return { code: 0, stdout: `${encodeControlReply<"import-project">({ ok: true, result: imported })}\n` };
    };
    const imported = { projectId: "project-1", macHead: "a".repeat(40), head: "a".repeat(40) };
    const bundle = Buffer.from("git bundle bytes");
    const project = { source: "mac-project-1", name: "throwaway", branch: "main" };
    expect(await brain.importProject({ ...project, bundle, origin: "https://example.com/throwaway.git" })).toEqual(imported);
    expect(heard).toEqual([{ op: "import-project", ...project, bundle: expect.stringMatching(/^\w[\w.-]*\.bundle$/), origin: "https://example.com/throwaway.git" }]);
    expect(vercel.gets.every((get) => !get.resume)).toBe(true);

    vercel.sandboxes.get("brain")!.state = "stopped";
    machine.changes.length = 0;
    await expect(brain.importProject({ ...project, name: "other", bundle })).rejects.toThrow(BrainUnavailable);
    expect(machine.changes).toEqual([]);
    expect(vercel.sandboxes.get("brain")!.state).toBe("stopped");
  });

  it("moves a thread's package into the running brain and reads one back, never waking a sleeping one", async () => {
    const { vercel, brain, machine } = await provisioned();
    const heard: BrainControlRequest[] = [];
    machine.answer = (request) => {
      heard.push(request);
      if (request.op !== "receive-thread") return { code: 69 };
      const uploaded = machine.files.get(`${ROOT}/inbox/${request.package}`);
      const result = uploaded?.toString() === "thread package" ? { received: true as const } : { refused: "No such package." };
      return { code: 0, stdout: `${encodeControlReply<"receive-thread">({ ok: true, result })}\n` };
    };
    expect(await brain.receiveThread("relocation-1", Buffer.from("thread package"))).toEqual({ received: true });
    expect(heard).toEqual([{ op: "receive-thread", relocation: "relocation-1", package: "relocation-1.thread" }]);
    machine.files.set(`${ROOT}/outbox/relocation-2.thread`, Buffer.from("package going home"));
    expect(Buffer.from(await brain.readOutbox("relocation-2.thread")).toString()).toBe("package going home");
    await expect(brain.readOutbox("missing.thread")).rejects.toThrow("no longer has");
    expect(vercel.gets.every((get) => !get.resume)).toBe(true);

    vercel.sandboxes.get("brain")!.state = "stopped";
    machine.changes.length = 0;
    await expect(brain.readOutbox("relocation-2.thread")).rejects.toThrow(BrainUnavailable);
    await expect(brain.receiveThread("relocation-3", Buffer.from("thread package"))).rejects.toThrow(BrainUnavailable);
    expect(machine.changes).toEqual([]);
    expect(vercel.sandboxes.get("brain")!.state).toBe("stopped");
  });

  it("keeps a brain made in another project there, and makes its thread sandboxes there too", async () => {
    const vercel = new FakeVercel();
    const access = { token: TOKEN, teamId: "team_1", project: "openorc-brain-qa" };
    const brain = await BrainMachine.connect(access, { api: vercel, startMs: 2000, pollMs: 1 });
    await brain.provision(bundle("brain-v1"));
    vercel.machine.onStart = (command) => command.emit("stdout", "openorc-brain ready brain-v1\n");
    await brain.wake({ key: newBrainKey(), name: "Cloud QA" });
    expect(vercel.projects).toEqual(["openorc-brain-qa"]);
    expect(vercel.opened.map((opened) => opened.projectId)).toEqual(["prj_openorc-brain-qa"]);
    expect(new Set(vercel.gets.map((get) => get.projectId))).toEqual(new Set(["prj_openorc-brain-qa"]));
    expect(parseLaunch(vercel.machine.starts[0]!.stdin.trim()).vercel?.connection.projectId).toBe("prj_openorc-brain-qa");
    expect(await (await BrainMachine.find(access, { api: vercel }))?.status()).toMatchObject({ state: "running" });
    expect(await BrainMachine.find({ token: TOKEN, teamId: "team_1" }, { api: vercel })).toBeNull();
  });

  it("deletes every sandbox in the brain's project, the brain first, with their orphan snapshots", async () => {
    const vercel = new FakeVercel();
    const settings = () => ({ ports: [], timeout: undefined, snapshotExpiration: undefined, keepLastSnapshots: undefined });
    vercel.add("openorc-thread-1", settings());
    vercel.add("brain", settings());
    vercel.add("openorc-thread-2", settings(), "stopped");
    vercel.kept = [snapshot("snap_left", { status: "created" }), snapshot("snap_gone", { status: "deleted" })];
    await (await connect(vercel)).remove();
    expect(vercel.deleted).toEqual(["brain", "openorc-thread-1", "openorc-thread-2"].map((name) => ({ name, options: { deleteOrphanSnapshots: true } })));
    // Vercel deletes orphan snapshots on its own, later, and once left one: any still kept go too.
    expect(vercel.snapshotsDeleted).toEqual(["snap_left"]);
    expect(vercel.sandboxes.size).toBe(0);
    expect(vercel.gets.every((get) => !get.resume)).toBe(true);
  });
});
