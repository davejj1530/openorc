import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainRefused,
  BrainUnavailable,
  brainKeyText,
  brainVersionNewer,
  copyHeads,
  openHandover,
  takeBranch,
  type BrainAccess,
  type BrainControlRequest,
  type BrainControlResults,
  type BrainKey,
  type BrainMachineStatus,
  type HandoverClaudeAccount,
  type ProjectBundle,
  type WakeResult,
} from "@openorc/cloud";
import { DEFAULT_CLAUDE_ACCOUNT, WORKSPACE_ID, brainRegionFor } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { OpenOrcOptions } from "../options.js";
import { rpcClient } from "../rpc-test-client.js";
import type { BrainMachineLike } from "./cloud-brain.js";

const VERCEL_TOKEN = "vcp_fixture-vercel-token-0123456789";
const PERSONAL = "sk-ant-oat01-personal-fixture-token-0123456789";
const WORK = "sk-ant-oat01-work-fixture-token-0123456789";

/** The brain's machine as far as the Mac can tell: a sandbox that wakes, opens handovers with the key it was started with, and pairs. */
class FakeBrain implements BrainMachineLike {
  state: BrainMachineStatus["state"] = "missing";
  /** Whether the team has the brain's project. */
  project = false;
  calls: string[] = [];
  access: BrainAccess[] = [];
  /** Each time the Mac reached for the machine: whether it could make the project, and how many records it had saved. */
  opens: { create: boolean; saved: number }[] = [];
  key: BrainKey | null = null;
  handovers: HandoverClaudeAccount[][] = [];
  wakes: WakeResult = { state: "ready", address: "sb-fixture.vercel.run", version: "v1" };
  /** The bundle on its machine, and the one its brain runs; null while no brain runs. */
  installed: string | null = null;
  running: string | null = null;
  /** Why the brain will not stop for an update: work running, or a brain from before such stops. */
  refusesUpdate: string | null = null;
  /** It stops for an update, but its answer never arrives. */
  losesStopReply = false;
  /** Asked to stop for an update, it neither answers in time nor stops. */
  stopTimesOut = false;
  upload: () => Promise<void> = async () => undefined;
  beforeWake: () => Promise<void> = async () => undefined;
  /** Its copies of the Mac's projects, real repositories at <copies>/<Mac project id>/<name>. */
  copies = "";
  /** Threads it has in each copy, by the Mac project's id. */
  threads = new Map<string, number>();
  /** The version it ran as each project came. */
  importedOn: (string | null)[] = [];
  /** Its copies lack the commit any bundle builds on, as when that commit went missing. */
  lacksBase = false;
  /** Why it will not take a project, as when its copy's checkout blocks the fast-forward. */
  refusesImport: string | null = null;
  /** Why it will not list its copies, as a brain from before projects. */
  refusesProjects: string | null = null;
  beforeProjects: () => Promise<void> = async () => undefined;

  async status() {
    this.calls.push("status");
    return { state: this.state, address: this.state === "missing" ? null : "sb-fixture.vercel.run", expiresAt: null };
  }
  async provision(bundle: { version: string; archive: Buffer }, options: { region?: string } = {}) {
    this.calls.push(`provision ${bundle.version} ${bundle.archive.toString()} ${options.region}`);
    await this.upload();
    if (this.state === "missing") this.state = "stopped";
    if (!this.installed || !brainVersionNewer(this.installed, bundle.version)) this.installed = bundle.version;
    return { installed: this.installed, running: this.running };
  }
  async wake(input: { key: BrainKey; name: string }) {
    this.calls.push("wake");
    await this.beforeWake();
    if (this.wakes.state !== "ready") return this.wakes;
    if (this.state !== "running") this.running = null;
    this.key = input.key;
    this.state = "running";
    this.running ??= this.installed;
    return { ...this.wakes, version: this.running ?? this.wakes.version };
  }
  async control(request: BrainControlRequest): Promise<never> {
    this.calls.push(`control ${request.op}`);
    if (this.state !== "running" || !this.key || !this.running) throw new BrainUnavailable();
    if (request.op === "stop-for-update") {
      if (this.refusesUpdate) throw new BrainRefused(this.refusesUpdate);
      if (this.stopTimesOut) throw new Error("The brain did not answer stop-for-update.");
      this.running = null;
      if (this.losesStopReply) throw new Error("The brain did not answer stop-for-update.");
      return { stopping: true } as never;
    }
    if (request.op === "handover") {
      this.handovers.push(openHandover(this.key, request).claude!.accounts);
      return { applied: ["claude"] } as never;
    }
    if (request.op === "pair") return { url: "openorc://pair#v1.fixture", expiresAt: Date.now() + 120_000 } as never;
    if (request.op === "projects") {
      await this.beforeProjects();
      if (this.refusesProjects) throw new BrainRefused(this.refusesProjects);
      return (await this.listCopies()) as never;
    }
    if (request.op === "remove-project") {
      const threads = this.threads.get(request.source) ?? 0;
      if (threads) return { removed: false, threads } as never;
      await rm(path.join(this.copies, request.source), { recursive: true, force: true });
      return { removed: true, threads: 0 } as never;
    }
    throw new Error(`unexpected ${request.op}`);
  }
  async importProject({ source, name, branch, bundle, origin }: ProjectBundle) {
    const incremental = Buffer.from(bundle).toString("latin1").split("\n\n")[0]!.includes("\n-");
    this.calls.push(`import ${name} ${incremental ? "incremental" : "whole"}`);
    if (this.state !== "running" || !this.key || !this.running) throw new BrainUnavailable();
    this.importedOn.push(this.running);
    if (incremental && this.lacksBase) return { lacksBase: true as const };
    if (this.refusesImport) throw new BrainRefused(this.refusesImport);
    const file = path.join(path.dirname(this.copies), `${randomUUID()}.bundle`);
    await writeFile(file, bundle);
    try {
      const taken = await takeBranch(path.join(this.copies, source, name), file, branch, origin ?? null);
      return "lacksBase" in taken ? taken : { projectId: `brain-${source}`, ...taken };
    } catch (error) {
      throw new BrainRefused(error instanceof Error ? error.message : String(error));
    } finally {
      await rm(file, { force: true });
    }
  }
  /** Where its copy of a Mac project is. */
  copy(source: string, name: string): string {
    return path.join(this.copies, source, name);
  }
  private async listCopies(): Promise<BrainControlResults["projects"]> {
    const copies: BrainControlResults["projects"]["copies"] = [];
    for (const source of await readdir(this.copies).catch(() => []))
      for (const name of await readdir(path.join(this.copies, source))) {
        const heads = await copyHeads(this.copy(source, name));
        if (heads) copies.push({ source, projectId: `brain-${source}`, ...heads, threads: this.threads.get(source) ?? 0 });
      }
    return { copies };
  }
  async remove() {
    this.calls.push("remove");
    this.state = "missing";
  }
}

function memoryStore() {
  const saved: string[] = [];
  return { load: async () => saved.at(-1) ?? null, save: async (value: string) => void saved.push(value), saved };
}

let root: string;
let core: OpenOrc;
let brain: FakeBrain;
let record: ReturnType<typeof memoryStore>;
let invalidated: string[];
let teamId: string;
/** The brain this Mac's build carries. */
let carried: string;
const rpc = rpcClient(() => core);

async function open(options: Partial<OpenOrcOptions> = {}): Promise<void> {
  core = await OpenOrc.create({
    dataDir: path.join(root, `data-${Math.random().toString(36).slice(2)}`),
    ephemeral: true,
    transport: { push: (message) => void (message.type === "invalidate" && invalidated.push(...message.keys)) },
    claudeCloudSecrets: memoryStore(),
    cloudBrainSecrets: record,
    cloudCredentials: async () => ({ token: VERCEL_TOKEN, teamId, projectId: "prj_sandboxes" }),
    cloudBrainBundle: async () => ({ version: carried, read: async () => Buffer.from("archive") }),
    cloudBrainMachine: async (access, create) => {
      brain.access.push(access);
      brain.opens.push({ create, saved: record.saved.length });
      if (create) brain.project = true;
      return brain.project ? brain : null;
    },
    ...options,
  });
}

const status = () => rpc("cloud.brain.status", {});
async function setUp(): Promise<void> {
  expect((await rpc("cloud.brain.create", { region: "sin1" })).state).toBe("setting-up");
  await vi.waitFor(async () => expect((await status()).state).toBe("ready"));
}
const stored = () => JSON.parse(record.saved.at(-1) || "null") as { key: string; region: string; teamId: string } | null;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-brain-"));
  brain = new FakeBrain();
  brain.copies = path.join(root, "brain", "projects");
  await mkdir(brain.copies, { recursive: true });
  record = memoryStore();
  invalidated = [];
  teamId = "team_fixture";
  carried = "v1";
  await open();
});

afterEach(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
});

describe("the cloud brain from the Mac", () => {
  it("sets up in the chosen region: a key made once, the build's brain installed and started, each Claude account handed over", async () => {
    const work = core.claudeAccounts.add("Work");
    const old = core.claudeAccounts.add("Old");
    await core.claudeCloudTokens.save(DEFAULT_CLAUDE_ACCOUNT, PERSONAL);
    await core.claudeCloudTokens.save(work.id, WORK);
    await core.claudeCloudTokens.save(old.id, "sk-ant-oat01-old-fixture-token-0123456789");
    core.claudeAccounts.update({ id: old.id, enabled: false });
    expect(await status()).toEqual({ state: "none", error: null });
    await setUp();
    expect(brain.calls).toEqual(["provision v1 archive sin1", "wake", "control handover", "status"]);
    expect(brain.access[0]).toEqual({ token: VERCEL_TOKEN, teamId: "team_fixture" });
    expect(brain.opens.slice(0, 2)).toEqual([
      { create: false, saved: 0 },
      { create: true, saved: 1 },
    ]);
    expect(brain.handovers).toEqual([
      [
        { id: DEFAULT_CLAUDE_ACCOUNT, name: "Existing CLI login", default: true, token: PERSONAL },
        { id: work.id, name: "Work", default: false, token: WORK },
      ],
    ]);
    expect(stored()).toMatchObject({ key: brainKeyText(brain.key!), region: "sin1", teamId: "team_fixture" });
    expect(record.saved.join("\n")).not.toContain(PERSONAL);
    expect(await status()).toEqual({ state: "ready", region: "sin1", machine: "awake", claude: ["Existing CLI login", "Work"], behind: false, working: null, error: null });

    const key = stored()!.key;
    await setUp();
    expect(new Set(record.saved.map((value) => JSON.parse(value).key))).toEqual(new Set([key]));
    expect(brainKeyText(brain.key!)).toBe(key);
  });

  it("answers the status without waking a sleeping brain", async () => {
    await setUp();
    brain.state = "stopped";
    brain.calls = [];
    expect(await status()).toMatchObject({ state: "ready", machine: "asleep" });
    expect(await status()).toMatchObject({ state: "ready", machine: "asleep" });
    expect(brain.calls).toEqual(["status", "status"]);
  });

  it("hands the Claude accounts over again whenever a cloud token is saved or removed, waking the brain for it", async () => {
    await core.claudeCloudTokens.save(DEFAULT_CLAUDE_ACCOUNT, PERSONAL);
    await setUp();
    brain.state = "stopped";
    invalidated = [];
    const work = core.claudeAccounts.add("Work");
    await core.claudeCloudTokens.save(work.id, WORK);
    await vi.waitFor(() => expect(brain.handovers).toHaveLength(2));
    expect(brain.handovers[1]!.map((account) => account.id)).toEqual([DEFAULT_CLAUDE_ACCOUNT, work.id]);
    expect(brain.state).toBe("running");
    expect(invalidated).toContain("cloud-brain");
    await core.claudeCloudTokens.remove(DEFAULT_CLAUDE_ACCOUNT);
    await vi.waitFor(() => expect(brain.handovers).toHaveLength(3));
    expect(brain.handovers[2]).toEqual([{ id: work.id, name: "Work", default: false, token: WORK }]);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ claude: ["Work"], behind: false, working: null }));
  });

  it("pairs a phone through the brain, waking it first", async () => {
    await setUp();
    brain.state = "stopped";
    brain.calls = [];
    expect((await rpc("cloud.brain.pair", {})).url).toBe("openorc://pair#v1.fixture");
    expect(brain.calls).toEqual(["wake", "control pair"]);
  });

  it("removes the brain and forgets its key", async () => {
    await setUp();
    expect(await rpc("cloud.brain.remove", {})).toEqual({ state: "none", error: null });
    expect(brain.calls.at(-1)).toBe("remove");
    expect(stored()).toBeNull();
  });

  it("is where this Mac's cloud threads run while it is set up, unless Settings chooses another region", async () => {
    const vercel = memoryStore();
    await vercel.save(JSON.stringify({ vercel: { token: VERCEL_TOKEN, team: { id: teamId, name: "Team" }, project: { id: "prj_sandboxes", name: "openorc-sandboxes" } } }));
    await core.close();
    await open({ cloudSecrets: vercel });
    const threads = async () => (await rpc("cloud.status", {})).vercel?.region;
    expect(await threads()).toBe(brainRegionFor(Intl.DateTimeFormat().resolvedOptions().timeZone));

    invalidated = [];
    expect((await rpc("cloud.brain.create", { region: "cpt1" })).state).toBe("setting-up");
    await vi.waitFor(async () => expect((await status()).state).toBe("ready"));
    expect(invalidated).toContain("cloud");
    expect(await threads()).toBe("cpt1");

    expect((await rpc("cloud.vercel.region", { region: "syd1" })).vercel?.region).toBe("syd1");
    await rpc("cloud.brain.remove", {});
    expect(await threads()).toBe("syd1");
  });

  it("makes nothing in a team that has a brain this Mac has no key for, and can remove that one", async () => {
    brain.project = true;
    brain.state = "stopped";
    expect(await rpc("cloud.brain.create", { region: "sin1" })).toEqual({ state: "elsewhere", error: null });
    expect(brain.calls).toEqual(["status", "status"]);
    expect(record.saved).toEqual([]);
    expect(await rpc("cloud.brain.remove", {})).toEqual({ state: "none", error: null });
    expect(brain.calls.at(-1)).toBe("remove");
    expect(brain.calls).not.toContain("provision v1 archive sin1");
  });

  it("forgets a brain found elsewhere once it is gone, or Settings moves to another team", async () => {
    brain.project = true;
    brain.state = "stopped";
    expect((await rpc("cloud.brain.create", { region: "sin1" })).state).toBe("elsewhere");
    teamId = "team_other";
    expect(await status()).toEqual({ state: "none", error: null });
    teamId = "team_fixture";
    expect((await rpc("cloud.brain.create", { region: "sin1" })).state).toBe("elsewhere");
    brain.state = "missing";
    expect(await status()).toEqual({ state: "none", error: null });
  });

  it("looks at a brain whose project is gone without making the project again", async () => {
    await setUp();
    brain.project = false;
    brain.state = "missing";
    await core.close();
    await open();
    expect(await status()).toMatchObject({ state: "incomplete", region: "sin1", error: "The cloud brain's machine is gone." });
    expect(brain.project).toBe(false);
  });

  it("keeps why pairing found the brain needing setting up again", async () => {
    await setUp();
    brain.wakes = { state: "needs-provision", detail: "No brain is installed on its sandbox." };
    await expect(rpc("cloud.brain.pair", {})).rejects.toThrow("needs setting up again");
    expect(await status()).toEqual({ state: "incomplete", region: "sin1", error: "The cloud brain needs setting up again. No brain is installed on its sandbox." });
  });

  it("says why the brain did not start, without the Vercel token or the brain's key", async () => {
    brain.wakes = { state: "failed", detail: `Exited: token ${VERCEL_TOKEN}` };
    await rpc("cloud.brain.create", { region: "fra1" });
    await vi.waitFor(async () => expect((await status()).state).toBe("incomplete"));
    const shown = await status();
    expect(shown).toMatchObject({ state: "incomplete", region: "fra1" });
    expect(JSON.stringify(shown)).toContain("The cloud brain did not start.");
    expect(JSON.stringify(shown)).not.toContain(VERCEL_TOKEN);
  });

  it("never repeats a damaged record, which holds the key", async () => {
    record.saved.push('{"key": SECRETKEYTEXT-0123456789}');
    const shown = await status();
    expect(shown).toEqual({ state: "none", error: "Cannot access protected storage for the cloud brain. Unlock your OS keychain and retry." });
  });

  describe("updating it", () => {
    const OLD = "20261101120000-aaaaaaaaaaaa";
    const NEW = "20261102120000-bbbbbbbbbbbb";
    const BUSY = "Wait for agent work, approvals, and context maintenance to finish before restarting to update.";
    /** A brain set up from a build carrying OLD, asleep unless `awake`, now woken from a build carrying `now`. */
    async function setUpOn(now: string, { awake = false } = {}): Promise<void> {
      carried = OLD;
      await setUp();
      if (!awake) brain.state = "stopped";
      brain.calls = [];
      carried = now;
    }

    it("installs this build's newer brain before waking it, so the brain starts on it, then nothing more", async () => {
      await setUpOn(NEW);
      await rpc("cloud.brain.wake", {});
      expect(brain.calls).toEqual(["status", `provision ${NEW} archive sin1`, "wake", "status"]);
      expect(brain.running).toBe(NEW);
      expect(stored()).toMatchObject({ version: NEW });
      brain.state = "stopped";
      brain.calls = [];
      await rpc("cloud.brain.pair", {});
      expect(brain.calls).toEqual(["wake", "control pair"]);
    });

    it("never puts an older brain on its machine: a build carrying one leaves a newer brain alone, and still uses it", async () => {
      carried = NEW;
      await setUp();
      brain.state = "stopped";
      brain.calls = [];
      carried = OLD;
      expect((await rpc("cloud.brain.pair", {})).url).toBe("openorc://pair#v1.fixture");
      expect(brain.calls).toEqual(["wake", "control pair"]);
      expect([brain.installed, brain.running]).toEqual([NEW, NEW]);

      // A record from before versions were kept asks the machine, which keeps its newer brain, and is told so.
      record.saved.push(JSON.stringify({ ...stored(), version: undefined }));
      await core.close();
      await open();
      await rpc("cloud.brain.wake", {});
      expect([brain.installed, brain.running, stored()]).toEqual([NEW, NEW, expect.objectContaining({ version: NEW })]);
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(brain.calls).toEqual(["wake", "status"]);
    });

    it("restarts a brain running an older one onto the new one only once nothing would be cut short", async () => {
      await setUpOn(NEW, { awake: true });
      brain.refusesUpdate = BUSY;
      expect((await rpc("cloud.brain.pair", {})).url).toBe("openorc://pair#v1.fixture");
      expect(brain.calls).toEqual(["status", `provision ${NEW} archive sin1`, "wake", "control stop-for-update", "control pair"]);
      expect(brain.running).toBe(OLD);
      expect(await status()).toMatchObject({ working: null, error: null });

      brain.refusesUpdate = null;
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(brain.calls).toEqual(["wake", "control stop-for-update", "wake", "status"]);
      expect(brain.running).toBe(NEW);
    });

    it("starts the brain again when a stop for an update goes unanswered, since it may have stopped", async () => {
      await setUpOn(NEW, { awake: true });
      brain.losesStopReply = true;
      expect((await rpc("cloud.brain.pair", {})).url).toBe("openorc://pair#v1.fixture");
      expect(brain.calls).toEqual(["status", `provision ${NEW} archive sin1`, "wake", "control stop-for-update", "wake", "control pair"]);
      expect(brain.running).toBe(NEW);
    });

    it("installs this build's brain again once the machine went back to an older one, rather than restarting onto it forever", async () => {
      await setUpOn(NEW);
      await rpc("cloud.brain.wake", {});
      brain.installed = OLD;
      brain.running = OLD;
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(brain.calls).toEqual(["wake", "control stop-for-update", "wake", "status"]);
      expect(stored()).toMatchObject({ version: OLD });
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(brain.calls).toEqual(["status", `provision ${NEW} archive sin1`, "wake", "control stop-for-update", "wake", "status"]);
      expect(brain.running).toBe(NEW);
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(brain.calls).toEqual(["wake", "status"]);
    });

    it("restarts an idle brain running an older one when set up again, showing the setup's own steps meanwhile", async () => {
      await setUpOn(NEW, { awake: true });
      let restart: (() => void) | undefined;
      brain.beforeWake = async () => {
        if (brain.calls.filter((call) => call === "wake").length === 2) await new Promise<void>((resolve) => (restart = resolve));
      };
      await rpc("cloud.brain.create", { region: "sin1" });
      await vi.waitFor(() => expect(restart).toBeDefined());
      expect(await status()).toEqual({ state: "setting-up", region: "sin1", step: "start" });
      restart!();
      await vi.waitFor(async () => expect((await status()).state).toBe("ready"));
      expect(brain.calls.filter((call) => call !== "status")).toEqual([`provision ${NEW} archive sin1`, "wake", "control stop-for-update", "wake", "control handover"]);
      expect(brain.running).toBe(NEW);
    });

    it("keeps a brain from before stops for an update running, and hands it the sign-ins all the same", async () => {
      await core.claudeCloudTokens.save(DEFAULT_CLAUDE_ACCOUNT, PERSONAL);
      await setUpOn(NEW, { awake: true });
      brain.refusesUpdate = "The brain's control request is not valid: op is missing or wrong.";
      const work = core.claudeAccounts.add("Work");
      await core.claudeCloudTokens.save(work.id, WORK);
      await vi.waitFor(() => expect(brain.handovers).toHaveLength(2));
      expect(brain.running).toBe(OLD);
      await vi.waitFor(async () => expect(await status()).toMatchObject({ claude: ["Existing CLI login", "Work"], behind: false, working: null, error: null }));
    });

    it("shows it updating while it installs, without the status waking the brain", async () => {
      await setUpOn(NEW);
      let uploaded!: () => void;
      brain.upload = () => new Promise((resolve) => (uploaded = resolve));
      const woken = rpc("cloud.brain.wake", {});
      await vi.waitFor(async () => expect(await status()).toMatchObject({ working: "updating" }));
      expect(brain.calls).not.toContain("wake");
      uploaded();
      expect(await woken).toMatchObject({ machine: "awake", working: null, error: null });
    });

    it("starts the brain on what it has when the update fails, says why, and updates it the next time", async () => {
      await setUpOn(NEW);
      brain.upload = async () => {
        throw new Error(`Upload refused for ${VERCEL_TOKEN}.`);
      };
      expect((await rpc("cloud.brain.pair", {})).url).toBe("openorc://pair#v1.fixture");
      expect(brain.running).toBe(OLD);
      expect(await status()).toMatchObject({ error: "The cloud brain could not be updated. Upload refused for [redacted]." });

      brain.upload = async () => undefined;
      expect(await rpc("cloud.brain.wake", {})).toMatchObject({ working: null, error: null });
      expect(brain.running).toBe(NEW);
    });

    it("leaves a brain whose machine is gone to be set up again, instead of installing on an empty one", async () => {
      await setUpOn(NEW);
      brain.state = "missing";
      brain.wakes = { state: "needs-provision", detail: "The brain's sandbox does not exist." };
      await rpc("cloud.brain.wake", {});
      expect(brain.calls.filter((call) => call.startsWith("provision"))).toEqual([]);
      expect(await status()).toMatchObject({ state: "incomplete", error: expect.stringContaining("needs setting up again") });
    });
  });

  describe("projects on it", () => {
    const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8", stdio: "pipe" }).trim();
    const HAS_THREADS = "It has threads on the cloud brain.";
    const projects = () => rpc("cloud.brain.projects", {});
    const choose = (projectId: string, on: boolean) => rpc("cloud.brain.project", { projectId, on });
    const records = () => (JSON.parse(record.saved.at(-1) || "null") as { projects?: unknown[] } | null)?.projects;
    const imports = () => brain.calls.filter((call) => call.startsWith("import"));

    function commit(folder: string, name: string, content: string): string {
      return (void writeFileSync(path.join(folder, name), content), git(folder, "add", "-A"), git(folder, "commit", "-q", "-m", name), git(folder, "rev-parse", "HEAD"));
    }

    /** A folder on this Mac added as a project: a Git repository with a first commit unless told otherwise. */
    async function macProject(name: string, { repository = true, commits = true, origin, branch = "main" }: { repository?: boolean; commits?: boolean; origin?: string; branch?: string } = {}) {
      const folder = path.join(root, "mac", name);
      await mkdir(folder, { recursive: true });
      if (repository) git(folder, "init", "-q", "-b", branch);
      if (origin) git(folder, "remote", "add", "origin", origin);
      if (repository && commits) commit(folder, "README.md", `# ${name}\n`);
      const { id } = await rpc("projects.import", { rootPath: folder });
      return { id, folder };
    }

    /** A project the brain has a copy of, the brain asleep since. */
    async function sent(name = "app") {
      const project = await macProject(name);
      await setUp();
      await choose(project.id, true);
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ id: project.id, sent: git(project.folder, "rev-parse", "main") })]));
      brain.state = "stopped";
      brain.calls = [];
      return project;
    }

    /** Wakes the brain from Settings. The refresh that follows runs before any later operation. */
    const wake = () => rpc("cloud.brain.wake", {});

    it("lists this Mac's projects, Workspace aside, all off, and only a Git repository with a commit can be switched on", async () => {
      const app = await macProject("app");
      const notes = await macProject("notes", { repository: false });
      const empty = await macProject("empty", { commits: false });
      await setUp();
      brain.calls = [];
      const row = { on: false, sending: false, kept: false, error: null };
      expect(await projects()).toEqual([
        { id: empty.id, name: "empty", ...row, blocked: "No commits yet." },
        { id: notes.id, name: "notes", ...row, blocked: "Not a Git repository." },
        { id: app.id, name: "app", ...row, blocked: null },
      ]);
      expect((await projects()).map((project) => project.id)).not.toContain(WORKSPACE_ID);

      expect((await choose(notes.id, true)).find((project) => project.id === notes.id)).toMatchObject({ on: false, blocked: "Not a Git repository." });
      expect(await status()).toMatchObject({ error: "Not a Git repository." });
      expect(brain.calls).toEqual(["status"]);
      expect(records()).toBeUndefined();
    });

    it("cannot switch on a project whose name or branch the brain would refuse", async () => {
      const long = await macProject("a".repeat(101));
      const odd = await macProject("odd", { branch: "trunk@2" });
      await setUp();
      const reason = "The cloud brain can't take this project's name or branch.";
      expect((await projects()).map(({ id, blocked }) => [id, blocked])).toEqual(
        expect.arrayContaining([
          [long.id, reason],
          [odd.id, reason],
        ]),
      );
    });

    it("sends a project switched on, whole, under its own name and origin less any sign-in, and records what it became and the commit sent", async () => {
      const app = await macProject("app", { origin: "https://me:ghp_fixture-secret@github.com/me/app.git" });
      await setUp();
      brain.state = "stopped";
      brain.calls = [];
      await choose(app.id, true);
      const head = git(app.folder, "rev-parse", "main");
      await vi.waitFor(() => expect(records()).toEqual([{ id: app.id, brainId: `brain-${app.id}`, branch: "main", sent: head, head, threads: 0, error: null }]));
      expect(brain.calls.filter((call) => call !== "status")).toEqual(["wake", "control projects", "import app whole"]);
      const copy = brain.copy(app.id, "app");
      expect(git(copy, "rev-parse", "main")).toBe(head);
      expect(git(copy, "remote", "get-url", "origin")).toBe("https://github.com/me/app.git");
      expect(record.saved.join("\n")).not.toContain("ghp_fixture-secret");
      expect((await projects())[0]).toEqual({ id: app.id, name: "app", on: true, blocked: null, sending: false, kept: false, error: null });
    });

    it("never wakes the brain, nor asks Vercel, to show them", async () => {
      await sent();
      await projects();
      await projects();
      expect(brain.calls).toEqual([]);
      expect(brain.state).toBe("stopped");
    });

    it("sends only what is new on each wake: nothing while the default branch stays put, nor when switched on again", async () => {
      const app = await sent();
      const copy = brain.copy(app.id, "app");
      await wake();
      // Switching on again queues behind the refresh the wake started, so it has ended when this returns.
      await choose(app.id, true);
      git(app.folder, "switch", "-q", "-c", "feature");
      commit(app.folder, "feature.txt", "not on main\n");
      await wake();
      await choose(app.id, true);
      expect(imports()).toEqual([]);

      git(app.folder, "switch", "-q", "main");
      const next = commit(app.folder, "b.txt", "b1\n");
      brain.state = "stopped";
      await wake();
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ sent: next, head: next })]));
      expect(git(copy, "rev-parse", "main")).toBe(next);
      expect(imports()).toEqual(["import app incremental"]);
    });

    it("sends what is new after pairing a phone, the code first, and after handing over sign-ins", async () => {
      const app = await sent();
      const paired = commit(app.folder, "b.txt", "b1\n");
      let answer!: () => void;
      brain.beforeProjects = () => new Promise((resolve) => (answer = resolve));
      expect((await rpc("cloud.brain.pair", {})).url).toBe("openorc://pair#v1.fixture");
      await vi.waitFor(() => expect(answer).toBeDefined());
      brain.beforeProjects = async () => undefined;
      answer();
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ sent: paired })]));

      brain.state = "stopped";
      const handed = commit(app.folder, "c.txt", "c1\n");
      await core.claudeCloudTokens.save(DEFAULT_CLAUDE_ACCOUNT, PERSONAL);
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ sent: handed })]));
      expect(brain.handovers.at(-1)?.map((account) => account.token)).toEqual([PERSONAL]);
      expect(imports()).toEqual(["import app incremental", "import app incremental"]);
    });

    it("keeps the brain's copy when it has commits of its own on the default branch, and says so", async () => {
      const app = await sent();
      const copy = brain.copy(app.id, "app");
      const own = commit(copy, "brain.txt", "made on the brain\n");
      const next = commit(app.folder, "b.txt", "b1\n");
      await wake();
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ sent: next, head: own, error: null })]));
      expect(imports()).toEqual(["import app incremental"]);
      expect(git(copy, "rev-parse", "main")).toBe(own);
      expect((await projects())[0]).toMatchObject({ on: true, kept: true, error: null });
      expect(await status()).toMatchObject({ error: null });
    });

    it("sends the whole branch to a brain that lost its copy, or cannot take only what is new", async () => {
      const app = await sent();
      const copy = brain.copy(app.id, "app");
      const head = git(app.folder, "rev-parse", "main");
      await rm(path.join(brain.copies, app.id), { recursive: true });
      await wake();
      await vi.waitFor(() => expect(git(copy, "rev-parse", "main")).toBe(head));
      expect(imports()).toEqual(["import app whole"]);

      brain.lacksBase = true;
      const next = commit(app.folder, "b.txt", "b1\n");
      await wake();
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ sent: next, head: next, error: null })]));
      expect(imports()).toEqual(["import app whole", "import app incremental", "import app whole"]);
      expect(git(copy, "rev-parse", "main")).toBe(next);
    });

    it("shows why the brain would not take what is new, without sending the whole branch for it", async () => {
      const app = await sent();
      brain.refusesImport = "git merge --ff-only failed: Your local changes would be overwritten.";
      commit(app.folder, "b.txt", "b1\n");
      await wake();
      await vi.waitFor(async () => expect((await projects())[0]).toMatchObject({ on: true, error: brain.refusesImport }));
      expect(imports()).toEqual(["import app incremental"]);
      expect((await projects())[0]).toMatchObject({ kept: false });
    });

    it("leaves projects for a later wake while the brain runs an older version than its machine has", async () => {
      carried = "20261101120000-aaaaaaaaaaaa";
      const app = await sent();
      brain.state = "running";
      brain.refusesUpdate = "Wait for agent work to finish before restarting to update.";
      carried = "20261102120000-bbbbbbbbbbbb";
      commit(app.folder, "b.txt", "b1\n");
      await wake();
      await choose(app.id, true);
      expect(brain.running).toBe("20261101120000-aaaaaaaaaaaa");
      expect(brain.calls.filter((call) => call.startsWith("control"))).toEqual(["control stop-for-update"]);
      expect((await projects())[0]).toMatchObject({ on: true, error: null });

      brain.refusesUpdate = null;
      brain.stopTimesOut = true;
      await wake();
      await choose(app.id, true);
      expect(brain.calls.filter((call) => call.startsWith("control"))).toEqual(["control stop-for-update", "control stop-for-update"]);

      brain.stopTimesOut = false;
      const next = git(app.folder, "rev-parse", "main");
      await wake();
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ sent: next })]));
      expect(brain.importedOn.at(-1)).toBe(carried);
    });

    it("shows on each project why the brain could not say what it has, until it can", async () => {
      const app = await sent();
      brain.refusesProjects = "The brain's control request is not valid: op is missing or wrong.";
      await wake();
      await vi.waitFor(async () => expect((await projects())[0]).toMatchObject({ on: true, error: brain.refusesProjects }));
      brain.refusesProjects = null;
      await wake();
      await vi.waitFor(async () => expect((await projects())[0]).toMatchObject({ on: true, error: null }));
      expect(imports()).toEqual([]);
      expect(records()).toEqual([expect.objectContaining({ id: app.id, sent: git(app.folder, "rev-parse", "main"), error: null })]);
    });

    it("removes a project switched off only while the brain has no thread in it, else keeps it on, saying why", async () => {
      const app = await sent();
      brain.threads.set(app.id, 1);
      await choose(app.id, false);
      expect(brain.calls.filter((call) => call !== "status").slice(0, 2)).toEqual(["wake", "control remove-project"]);
      expect((await projects())[0]).toMatchObject({ on: true, blocked: HAS_THREADS });
      expect(records()).toEqual([expect.objectContaining({ id: app.id, threads: 1 })]);
      await vi.waitFor(() => expect(brain.calls).toContain("control projects"));

      brain.calls = [];
      await choose(app.id, false);
      expect(brain.calls).toEqual([]);

      brain.threads.set(app.id, 0);
      await wake();
      await vi.waitFor(async () => expect((await projects())[0]).toMatchObject({ on: true, blocked: null }));
      await choose(app.id, false);
      expect((await projects())[0]).toMatchObject({ on: false, blocked: null });
      expect(records()).toEqual([]);
      expect(await readdir(brain.copies)).toEqual([]);
    });

    it("updates the brain to this build's version first, then sends what is new", async () => {
      carried = "20261101120000-aaaaaaaaaaaa";
      const app = await sent();
      const next = commit(app.folder, "b.txt", "b1\n");
      carried = "20261102120000-bbbbbbbbbbbb";
      await wake();
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ sent: next })]));
      expect(imports()).toEqual(["import app incremental"]);
      const at = (call: string) => brain.calls.indexOf(call);
      expect(at(`provision ${carried} archive sin1`)).toBeGreaterThanOrEqual(0);
      expect(at(`provision ${carried} archive sin1`)).toBeLessThan(at("wake"));
      expect(at("wake")).toBeLessThan(at("control projects"));
      expect(at("control projects")).toBeLessThan(at("import app incremental"));
      expect(brain.importedOn).toEqual(["20261101120000-aaaaaaaaaaaa", carried]);
    });
  });

  it("offers no brain in a build without one", async () => {
    await core.close();
    await open({ cloudBrainBundle: async () => null });
    expect(await status()).toEqual({ state: "unavailable" });
    await expect(rpc("cloud.brain.create", { region: "sin1" })).rejects.toThrow("isn't available in this build");
    expect(brain.calls).toEqual([]);
  });
});
