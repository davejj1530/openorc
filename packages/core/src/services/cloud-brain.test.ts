import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainRefused,
  BrainUnavailable,
  VercelRefusal,
  brainKeyText,
  brainVersionNewer,
  copyHeads,
  openHandover,
  takeBranch,
  type BrainAccess,
  type AgentVersions,
  type BrainControlRequest,
  type BrainControlResults,
  type BrainKey,
  type BrainMachineStatus,
  type BrainPhone,
  type CopySettings,
  type DoorAccess,
  type DoorBundle,
  type DoorDeployOptions,
  type DoorOpening,
  type HandoverClaudeAccount,
  type OpenedDoor,
  type ProjectBundle,
  type WakeInput,
  type WakeResult,
} from "@openorc/cloud";
import { Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, WORKSPACE_ID, brainRegionFor, type CloudService } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { inheritedProbe } from "./shell-environment.js";
import type { OpenOrcOptions } from "../options.js";
import { rpcClient } from "../rpc-test-client.js";
import type { BrainDoors } from "./cloud-brain-door.js";
import { CloudBrain } from "./cloud-brain.js";
import type { BrainMachineLike } from "./cloud-brain-machine.js";

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
  wakeInputs: WakeInput[] = [];
  wakes: WakeResult = { state: "ready", address: "sb-fixture.vercel.run", version: "v1" };
  /** The bundle on its machine, and the one its brain runs; null while no brain runs. */
  installed: string | null = null;
  running: string | null = null;
  /** What the brain says keeps it awake. */
  busy: string | null = null;
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
  /** The copies the Mac said hold its branch as it is now. */
  confirmed: { source: string; macHead: string }[] = [];
  /** The agent CLI versions the Mac asked the brain to run, each time it asked. */
  agentVersions: AgentVersions[] = [];
  /** Each copy's settings as the Mac last sent them, by Mac project. */
  settings = new Map<string, CopySettings>();
  /** The version it ran as each project came. */
  importedOn: (string | null)[] = [];
  /** Its copies lack the commit any bundle builds on, as when that commit went missing. */
  lacksBase = false;
  /** Why it will not take a project, as when its copy's checkout blocks the fast-forward. */
  refusesImport: string | null = null;
  /** Why it will not list its copies, as a brain from before projects. */
  refusesProjects: string | null = null;
  beforeProjects: () => Promise<void> = async () => undefined;
  /** The phones paired with it. */
  phones: BrainPhone[] = [];

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
  async wake(input: WakeInput) {
    this.calls.push("wake");
    this.wakeInputs.push(input);
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
    if (request.op === "status") return { state: "ready", version: this.running, pid: 1, since: 1, busy: this.busy } as never;
    if (request.op === "phones") return { phones: this.phones } as never;
    if (request.op === "remove-phone") {
      this.phones = this.phones.filter((phone) => phone.id !== request.id);
      return { phones: this.phones } as never;
    }
    if (request.op === "projects") {
      await this.beforeProjects();
      if (this.refusesProjects) throw new BrainRefused(this.refusesProjects);
      return (await this.listCopies()) as never;
    }
    if (request.op === "agent-versions") {
      this.agentVersions.push(request.versions);
      return { versions: request.versions } as never;
    }
    if (request.op === "copies-current") {
      this.confirmed.push(...request.copies);
      return { marked: request.copies.length } as never;
    }
    if (request.op === "project-settings") {
      this.settings.set(request.source, request.settings);
      return { applied: true } as never;
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
  /** What Vercel says the brain and its thread sandboxes ran this month, at list prices. */
  usd = 1.25;
  async costSince(since: number) {
    this.calls.push(`cost ${since}`);
    return this.usd;
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
    shellProbe: inheritedProbe(env),
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
    // Never Vercel's.
    cloudBrainDoors: new FakeDoors(() => brain.calls),
    // A brain that refuses the restart is asked once, unless a test waits for it.
    cloudBrainUpdateWait: { waitMs: 1, forMs: 0 },
    ...options,
  });
}

const status = () => rpc("cloud.brain.status", {});
async function setUp(): Promise<void> {
  expect((await rpc("cloud.brain.create", { region: "sin1" })).state).toBe("setting-up");
  await vi.waitFor(async () => expect((await status()).state).toBe("ready"), { timeout: 5000 });
}
/** What this Mac asked of the brain's machine, less the read of what the brain holds that follows each wake in the background. */
const asked = () => brain.calls.filter((call) => call !== "control sign-ins");
const stored = () => JSON.parse(record.saved.at(-1) || "null") as { key: string; region: string; teamId: string } | null;

/** Stand-in agent CLIs on this Mac that only say their versions, which the brain is brought to. */
const MAC_VERSIONS = { claude: "2.1.317 (Claude Code)", codex: "codex-cli 0.166.0", opencode: "opencode v2.0.11" };
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-brain-"));
  await mkdir(path.join(root, "bin"));
  env = { ...process.env };
  for (const [agent, line] of Object.entries(MAC_VERSIONS)) {
    await writeFile(path.join(root, "bin", agent), `#!/bin/sh\necho "${line}"\n`, { mode: 0o755 });
    env[`OPENORC_${agent.toUpperCase()}_BIN`] = path.join(root, "bin", agent);
  }
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
  // A copy's git may still be writing as the folder goes.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    expect(asked()).toEqual(["provision v1 archive sin1", "wake", "control agent-versions", "control handover", "status"]);
    // Its agent CLIs are brought to this Mac's as it starts; later wakes ask only once one changed.
    expect(brain.agentVersions).toEqual([{ claude: "2.1.317", codex: "0.166.0", opencode: "2.0.11" }]);
    expect(brain.access[0]).toEqual({ service: "vercel", token: VERCEL_TOKEN, teamId: "team_fixture" });
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
    expect(await status()).toEqual({
      state: "ready",
      service: "vercel",
      region: "sin1",
      machine: "awake",
      claude: ["Existing CLI login", "Work"],
      behind: false,
      working: null,
      door: null,
      threads: 0,
      error: null,
    });

    const key = stored()!.key;
    await setUp();
    expect(new Set(record.saved.map((value) => JSON.parse(value).key))).toEqual(new Set([key]));
    expect(brainKeyText(brain.key!)).toBe(key);
  });

  it("says what the brain and its thread sandboxes cost this month, from Vercel, asked at most every ten minutes, never waking it", async () => {
    expect(await rpc("cloud.brain.cost", {})).toBeNull();
    await setUp();
    brain.state = "stopped";
    brain.calls = [];
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    expect(await rpc("cloud.brain.cost", {})).toEqual({ usd: 1.25, since });
    brain.usd = 2;
    expect(await rpc("cloud.brain.cost", {})).toEqual({ usd: 1.25, since });
    expect(brain.calls).toEqual([`cost ${since}`]);
  });

  it("says what keeps the brain awake as it says it, and nothing while it sleeps, never waking it", async () => {
    expect(await rpc("cloud.brain.busy", {})).toBeNull();
    await setUp();
    brain.busy = "phones";
    expect(await rpc("cloud.brain.busy", {})).toBe("phones");
    brain.busy = null;
    expect(await rpc("cloud.brain.busy", {})).toBeNull();
    brain.state = "stopped";
    brain.busy = "agents";
    brain.calls = [];
    expect(await rpc("cloud.brain.busy", {})).toBeNull();
    expect(brain.calls.filter((call) => call === "wake")).toEqual([]);
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

  it("tells phones which brain it removed, by the key they saved it under; a brain it never reached adds none", async () => {
    await setUp();
    await (core as unknown as { cloudParts: { brain: CloudBrain } }).cloudParts.brain.rememberLinkKey("brain-link-key");
    await rpc("cloud.brain.remove", {});
    expect(await core.remote.device("phone", "brains.removed", {})).toEqual(["brain-link-key"]);
    await setUp();
    await rpc("cloud.brain.remove", {});
    expect(await core.remote.device("phone", "brains.removed", {})).toEqual(["brain-link-key"]);
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
    expect(await rpc("cloud.brain.create", { region: "sin1" })).toEqual({ state: "elsewhere", service: "vercel", error: null });
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
    expect(await status()).toEqual({ state: "incomplete", service: "vercel", region: "sin1", error: "The cloud brain needs setting up again. No brain is installed on its sandbox." });
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
      expect(asked()).toEqual(["status", `provision ${NEW} archive sin1`, "wake", "status"]);
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
      expect(asked()).toEqual(["wake", "status"]);
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
      expect(asked()).toEqual(["wake", "control stop-for-update", "wake", "status"]);
      expect(brain.running).toBe(NEW);
    });

    it("waits for a brain busy for a moment, as right after a failed start, and restarts it onto the new one", async () => {
      await core.close();
      await open({ cloudBrainUpdateWait: { waitMs: 5, forMs: 2000 } });
      await setUpOn(NEW, { awake: true });
      brain.refusesUpdate = BUSY;
      const control = brain.control.bind(brain);
      brain.control = async (request) => {
        const answer = control(request);
        if (request.op === "stop-for-update") brain.refusesUpdate = null;
        return answer;
      };
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(asked()).toEqual(["status", `provision ${NEW} archive sin1`, "wake", "control stop-for-update", "control stop-for-update", "wake", "status"]);
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
      expect(asked()).toEqual(["wake", "control stop-for-update", "wake", "status"]);
      expect(stored()).toMatchObject({ version: OLD });
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(asked()).toEqual(["status", `provision ${NEW} archive sin1`, "wake", "control stop-for-update", "wake", "status"]);
      expect(brain.running).toBe(NEW);
      brain.calls = [];
      await rpc("cloud.brain.wake", {});
      expect(asked()).toEqual(["wake", "status"]);
    });

    it("restarts an idle brain running an older one when set up again, showing the setup's own steps meanwhile", async () => {
      await setUpOn(NEW, { awake: true });
      let restart: (() => void) | undefined;
      brain.beforeWake = async () => {
        if (brain.calls.filter((call) => call === "wake").length === 2) await new Promise<void>((resolve) => (restart = resolve));
      };
      await rpc("cloud.brain.create", { region: "sin1" });
      await vi.waitFor(() => expect(restart).toBeDefined());
      expect(await status()).toEqual({ state: "setting-up", service: "vercel", region: "sin1", step: "start" });
      restart!();
      await vi.waitFor(async () => expect((await status()).state).toBe("ready"));
      expect(asked().filter((call) => call !== "status")).toEqual([`provision ${NEW} archive sin1`, "wake", "control stop-for-update", "wake", "control handover"]);
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
      const row = { on: false, sending: false, kept: false, error: null, branch: null };
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
      await vi.waitFor(() => expect(records()).toEqual([{ id: app.id, brainId: `brain-${app.id}`, branch: "main", sent: head, head, threads: 0, error: null, settings: expect.any(String) }]));
      expect(asked().filter((call) => call !== "status")).toEqual(["wake", "control projects", "import app whole", "control project-settings"]);
      const copy = brain.copy(app.id, "app");
      expect(git(copy, "rev-parse", "main")).toBe(head);
      expect(git(copy, "remote", "get-url", "origin")).toBe("https://github.com/me/app.git");
      expect(record.saved.join("\n")).not.toContain("ghp_fixture-secret");
      expect((await projects())[0]).toEqual({ id: app.id, name: "app", on: true, blocked: null, sending: false, kept: false, error: null, branch: "main" });
    });

    it("says, before a project is added, which branch its copy takes, the commit it is on, and the branch checked out here when another", async () => {
      const app = await macProject("app");
      commit(app.folder, "login.ts", "export const login = 1;\n");
      const head = git(app.folder, "rev-parse", "--short", "main");
      expect(await rpc("cloud.brain.copy", { projectId: app.id })).toEqual({ branch: "main", commit: head, subject: "login.ts", checkedOut: null });
      git(app.folder, "checkout", "-q", "-b", "feature-x");
      commit(app.folder, "draft.ts", "draft\n");
      expect(await rpc("cloud.brain.copy", { projectId: app.id })).toEqual({ branch: "main", commit: head, subject: "login.ts", checkedOut: "feature-x" });
      const notes = await macProject("notes", { repository: false });
      await expect(rpc("cloud.brain.copy", { projectId: notes.id })).rejects.toThrow("Not a Git repository.");
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

    it("sends what is new while the brain and this Mac are awake, asking it nothing while no branch moved, and never waking it", async () => {
      const app = await sent();
      const freshen = () => (core as unknown as { cloudParts: { brain: CloudBrain } }).cloudParts.brain.freshenProjects();
      brain.state = "running";
      await freshen();
      expect(brain.calls).toEqual([]);
      const next = commit(app.folder, "b.txt", "b1\n");
      await freshen();
      expect(imports()).toEqual(["import app incremental"]);
      expect(records()).toEqual([expect.objectContaining({ sent: next, head: next, error: null })]);
      commit(app.folder, "c.txt", "c1\n");
      brain.state = "stopped";
      brain.calls = [];
      await freshen();
      expect(brain.calls).toEqual(["control projects"]);
      expect(records()).toEqual([expect.objectContaining({ sent: next, error: null })]);
    });

    it("moves the brain's copy to the project's new default branch, as from master to main, while both are awake", async () => {
      const app = await macProject("app", { branch: "master", origin: "https://github.com/example/app.git" });
      await setUp();
      await choose(app.id, true);
      await vi.waitFor(() => expect(records()).toEqual([expect.objectContaining({ branch: "master", sent: git(app.folder, "rev-parse", "master") })]));
      // Origin's default became main: the Mac has main from origin, and origin no longer has master.
      git(app.folder, "switch", "-q", "-c", "main");
      const next = commit(app.folder, "b.txt", "b1\n");
      git(app.folder, "update-ref", "refs/remotes/origin/main", "main");
      brain.calls = [];
      await (core as unknown as { cloudParts: { brain: CloudBrain } }).cloudParts.brain.freshenProjects();
      expect(records()).toEqual([expect.objectContaining({ branch: "main", sent: next, head: next, error: null })]);
      expect(imports()).toEqual(["import app incremental"]);
      expect(git(brain.copy(app.id, "app"), "symbolic-ref", "--short", "HEAD")).toBe("main");
    });

    it("gives the brain's copy the project's setup script, again when it changes while both are awake, and never waking it", async () => {
      const app = await sent();
      expect(brain.settings.get(app.id)).toMatchObject({ setupScript: null, branchPrefix: "openorc" });
      const freshen = () => (core as unknown as { cloudParts: { brain: CloudBrain } }).cloudParts.brain.freshenProjects();
      brain.state = "running";
      const updated = await core.handle({ type: "rpc", id: 1, method: "projects.updateSettings", params: { id: app.id, settings: { setupScript: "pnpm install" } } });
      expect(updated.type).toBe("rpc.result");
      brain.calls = [];
      await freshen();
      expect(brain.settings.get(app.id)).toMatchObject({ setupScript: "pnpm install" });
      expect(imports()).toEqual([]);
      brain.calls = [];
      await freshen();
      expect(brain.calls).toEqual([]);
    });

    it("tries a send that failed again only once the branch moved on, not at every look while both are awake", async () => {
      const app = await sent();
      const freshen = () => (core as unknown as { cloudParts: { brain: CloudBrain } }).cloudParts.brain.freshenProjects();
      brain.state = "running";
      brain.refusesImport = "The cloud copy has uncommitted changes in the way.";
      commit(app.folder, "b.txt", "b1\n");
      await freshen();
      expect(records()).toEqual([expect.objectContaining({ error: "The cloud copy has uncommitted changes in the way." })]);
      brain.calls = [];
      await freshen();
      expect(brain.calls).toEqual([]);
      brain.refusesImport = null;
      const next = commit(app.folder, "c.txt", "c1\n");
      await freshen();
      expect(records()).toEqual([expect.objectContaining({ sent: next, error: null })]);
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
      await vi.waitFor(() => expect(brain.calls).toContain("control copies-current"));

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

    it("counts the brain's conversations again for the Remove confirm while it runs, never waking it or sending a project", async () => {
      const app = await sent();
      brain.state = "running";
      brain.threads.set(app.id, 2);
      commit(app.folder, "b.txt", "b1\n");
      expect(await rpc("cloud.brain.recount", {})).toMatchObject({ state: "ready", threads: 2 });
      expect(imports()).toEqual([]);
      brain.state = "stopped";
      brain.threads.set(app.id, 3);
      brain.calls = [];
      expect(await rpc("cloud.brain.recount", {})).toMatchObject({ threads: 2 });
      expect(brain.calls).not.toContain("wake");
    });

    it("tells the brain which copies hold this Mac's branch as it is now, so their synced age starts again", async () => {
      const app = await sent();
      const head = git(app.folder, "rev-parse", "main");
      brain.confirmed = [];
      await wake();
      await vi.waitFor(() => expect(brain.confirmed).toEqual([{ source: app.id, macHead: head }]));
      expect(imports()).toEqual([]);
      brain.confirmed = [];
      commit(app.folder, "b.txt", "b1\n");
      await wake();
      await vi.waitFor(() => expect(imports()).toEqual(["import app incremental"]));
      expect(brain.confirmed).toEqual([]);
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

/** The brain's door on Vercel as the Mac sees it: what it was opened with, and the mark it answers with. */
class FakeDoors implements BrainDoors {
  opens: { access: DoorAccess; opening: DoorOpening; release: string; tidied: string | null }[] = [];
  closes: DoorAccess[] = [];
  removes: DoorAccess[] = [];
  served: string | null = null;
  fails: Error | null = null;
  hold: Promise<void> = Promise.resolve();
  constructor(private readonly log: () => string[]) {}

  open = async (access: DoorAccess, opening: DoorOpening, bundle: DoorBundle, options: DoorDeployOptions = {}): Promise<OpenedDoor> => {
    this.opens.push({ access, opening, release: bundle.release, tidied: options.tidied ?? null });
    if (this.fails) throw this.fails;
    const mark = createHash("sha256")
      .update(JSON.stringify([bundle.release, brainKeyText(opening.key), opening.vercel, opening.threadVcpus ?? null]))
      .digest("base64url")
      .slice(0, 22);
    const host = "openorc-door-abcdefghijklmnop.vercel.app";
    if (this.served === mark && options.tidied === mark) return { host, mark, deployed: false };
    options.deploying?.();
    await this.hold;
    this.served = mark;
    return { host, mark, deployed: true };
  };
  close = async (access: DoorAccess) => {
    this.closes.push(access);
    if (this.fails) throw this.fails;
    this.served = null;
  };
  remove = async (access: DoorAccess) => {
    this.removes.push(access);
    this.log().push("door remove");
    if (this.fails) throw this.fails;
    this.served = null;
  };
}

describe("the cloud brain's door", () => {
  let doors: FakeDoors;
  const DOOR = { release: "door-1", code: async () => Buffer.from("export {};") };
  const withDoor = async () => ({ version: carried, read: async () => Buffer.from("archive"), door: DOOR });
  /** Settings' own Vercel connection, so a change there reaches the brain as it does in the app. */
  const vercelSettings = () => {
    const store = memoryStore();
    void store.save(JSON.stringify({ vercel: { token: VERCEL_TOKEN, team: { id: "team_fixture", name: "Fixture" }, project: { id: "prj_sandboxes", name: "openorc-sandboxes" } } }));
    return store;
  };

  beforeEach(async () => {
    doors = new FakeDoors(() => brain.calls);
    await core.close();
    await open({ cloudBrainBundle: withDoor, cloudBrainDoors: doors });
  });

  it("opens after setup with the Mac's own wake, in the brain's team, and says it is open", async () => {
    await setUp();
    await vi.waitFor(async () => expect((await status()).state === "ready" && (await status())).toMatchObject({ door: { state: "open" } }));
    expect(doors.opens).toEqual([
      {
        access: { token: VERCEL_TOKEN, teamId: "team_fixture" },
        opening: { key: brain.key, vercel: { token: VERCEL_TOKEN, teamId: "team_fixture", project: "openorc-brain" }, name: "Cloud", revoked: [] },
        release: "door-1",
        tidied: null,
      },
    ]);
    expect(brain.calls.filter((call) => call === "wake")).toHaveLength(1);
  });

  it("looks again when this Mac starts and after each wake it makes, asking only the door once it is current", async () => {
    await setUp();
    await vi.waitFor(() => expect(doors.opens).toHaveLength(1));
    await core.close();
    brain.calls = [];
    await open({ cloudBrainBundle: withDoor, cloudBrainDoors: doors });
    await vi.waitFor(() => expect(doors.opens).toHaveLength(2));
    expect(doors.opens[1]!.tidied).toBeNull();
    expect(brain.calls).not.toContain("wake");
    brain.state = "stopped";
    await rpc("cloud.brain.wake", {});
    await vi.waitFor(() => expect(doors.opens).toHaveLength(3));
    expect(doors.opens[2]!.tidied).toBe(doors.served);
  });

  it("shows the door opening while it deploys, and why it failed without the token, while the brain stays ready", async () => {
    let deployed: () => void = () => undefined;
    doors.hold = new Promise((resolve) => (deployed = resolve));
    await setUp();
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "ready", door: { state: "opening" } }));
    deployed();
    await vi.waitFor(async () => expect(await status()).toMatchObject({ door: { state: "open" } }));
    doors.fails = new Error(`Vercel refused vercel-token ${VERCEL_TOKEN}`);
    await rpc("cloud.brain.wake", {});
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "ready", error: null, door: { state: "failed" } }));
    const shown = await status();
    expect(JSON.stringify(shown)).not.toContain(VERCEL_TOKEN);
    expect(shown).toMatchObject({ door: { error: "Vercel refused vercel-token [redacted]" } });
  });

  it("takes a new sandbox size into the door, which starts thread sandboxes with it", async () => {
    await core.close();
    await open({ cloudBrainBundle: withDoor, cloudBrainDoors: doors, cloudCredentials: undefined, cloudSecrets: vercelSettings() });
    await setUp();
    await vi.waitFor(() => expect(doors.opens).toHaveLength(1));
    await rpc("cloud.vercel.size", { vcpus: 4 });
    await vi.waitFor(() => expect(doors.opens).toHaveLength(2));
    expect(doors.opens[1]!.opening.threadVcpus).toBe(4);
  });

  it("is closed before the Vercel connection goes, which stays while it cannot be; a token Vercel refuses lets it go", async () => {
    await core.close();
    await open({ cloudBrainBundle: withDoor, cloudBrainDoors: doors, cloudCredentials: undefined, cloudSecrets: vercelSettings() });
    await setUp();
    doors.fails = new Error("fetch failed");
    await expect(rpc("cloud.vercel.disconnect", {})).rejects.toThrow("Could not close the cloud brain's door. fetch failed");
    expect((await rpc("cloud.status", {})).vercel).not.toBeNull();
    doors.fails = new VercelRefusal("The token is not valid.", 403);
    expect((await rpc("cloud.vercel.disconnect", {})).vercel).toBeNull();
    expect(doors.closes).toEqual([
      { token: VERCEL_TOKEN, teamId: "team_fixture" },
      { token: VERCEL_TOKEN, teamId: "team_fixture" },
    ]);
  });

  it("is removed before the brain, which stays while the door cannot go; a token Vercel refuses lets it be", async () => {
    await setUp();
    doors.fails = new Error("Vercel answered 500.");
    await rpc("cloud.brain.remove", {});
    expect(brain.calls).toContain("door remove");
    expect(brain.calls).not.toContain("remove");
    expect(await status()).toMatchObject({ state: "ready", error: "Could not remove the cloud brain's door. Vercel answered 500." });
    doors.fails = new VercelRefusal("Not authorized.", 403);
    brain.calls = [];
    await rpc("cloud.brain.remove", {});
    expect(brain.calls).toEqual(["door remove", "remove"]);
    doors.fails = null;
    expect(await status()).toEqual({ state: "none", error: null });
    expect(doors.removes).toHaveLength(2);
    expect(doors.removes[0]).toEqual({ token: VERCEL_TOKEN, teamId: "team_fixture" });
  });

  it("refuses a phone unpaired from the brain, which wakes for it, while Settings lists the phones without waking it", async () => {
    const pocket = { id: randomUUID(), name: "Pocket", createdAt: 1_000, lastSeenAt: 5_000, connected: false };
    const tablet = { id: randomUUID(), name: "Tablet", createdAt: 2_000, lastSeenAt: null, connected: false };
    brain.phones = [pocket, tablet];
    await setUp();
    await vi.waitFor(async () => expect(await rpc("cloud.brain.phones", {})).toEqual([pocket, tablet]));
    await vi.waitFor(() => expect(doors.opens).toHaveLength(1));
    expect(doors.opens[0]!.opening.revoked).toEqual([]);

    brain.state = "stopped";
    brain.calls = [];
    expect(await rpc("cloud.brain.phones", {})).toEqual([pocket, tablet]);
    expect(brain.calls).not.toContain("wake");
    expect(await rpc("cloud.brain.phones.remove", { id: pocket.id })).toEqual([tablet]);
    expect(brain.calls.slice(0, 2)).toEqual(["wake", "control remove-phone"]);
    expect(brain.phones).toEqual([tablet]);
    await vi.waitFor(() => expect(doors.opens.at(-1)!.opening.revoked).toEqual([pocket.id]));

    brain.state = "stopped";
    brain.wakes = { state: "failed", detail: "Exited." };
    expect(await rpc("cloud.brain.phones.remove", { id: tablet.id })).toEqual([tablet]);
    expect(await status()).toMatchObject({ state: "ready", error: "The cloud brain did not start. Exited." });

    await rpc("cloud.brain.remove", {});
    expect(await rpc("cloud.brain.phones", {})).toEqual([]);
  });

  it("shows a phone paired with the brain's code within seconds while the code is out", async () => {
    await setUp();
    await rpc("cloud.brain.phones", {});
    await vi.waitFor(() => expect(brain.calls).toContain("control phones"));
    await rpc("cloud.brain.pair", {});
    const pocket = { id: randomUUID(), name: "Pocket", createdAt: Date.now(), lastSeenAt: Date.now(), connected: true };
    brain.phones = [pocket];
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11_000 });
    try {
      await rpc("cloud.brain.phones", {});
      await vi.waitFor(async () => expect(await rpc("cloud.brain.phones", {})).toEqual([{ ...pocket, lastSeenAt: expect.any(Number) }]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("is never opened by a build without one", async () => {
    await core.close();
    await open({ cloudBrainDoors: doors });
    await setUp();
    await rpc("cloud.brain.wake", {});
    expect(doors.opens).toEqual([]);
    expect(await status()).toMatchObject({ state: "ready", door: null });
  });

  it("puts the brain and its door in the projects it is given", async () => {
    const access: BrainAccess[] = [];
    const service = new CloudBrain({
      db: Db.memory(),
      store: memoryStore(),
      tokens: { status: async () => ({}), token: async () => null },
      vercel: async () => ({ token: VERCEL_TOKEN, teamId: "team_fixture" }),
      bundle: withDoor,
      changed: () => undefined,
      open: async (given, create) => {
        access.push(given);
        if (create) brain.project = true;
        return brain.project ? brain : null;
      },
      doors,
      projects: { brain: "openorc-brain-qa", door: "openorc-door-qa" },
    });
    await service.create("sin1");
    await vi.waitFor(() => expect(doors.opens).toHaveLength(1));
    expect(new Set(access.map((given) => given.service === "vercel" && given.project))).toEqual(new Set(["openorc-brain-qa"]));
    expect(doors.opens[0]).toMatchObject({ access: { project: "openorc-door-qa" }, opening: { vercel: { project: "openorc-brain-qa" } } });
  });
});

describe("the cloud brain on Agent37", () => {
  const AGENT37 = { key: "sk_live_agent37-fixture-key-0123456789", cpu: 4, memory: 16 } as const;
  const bundle = async () => ({ version: carried, read: async () => Buffer.from("archive"), door: { release: "door-1", code: async () => Buffer.from("export {};") } });
  let doors: FakeDoors;

  /** A CloudBrain whose new brains go where `service` says, as Settings' choice does. */
  function cloudBrain(service: () => CloudService) {
    const access: BrainAccess[] = [];
    const cloud = new CloudBrain({
      db: Db.memory(),
      store: memoryStore(),
      tokens: { status: async () => ({}), token: async () => null },
      vercel: async () => ({ token: VERCEL_TOKEN, teamId: "team_fixture", vcpus: 4 }),
      agent37: async () => AGENT37,
      service: async () => service(),
      bundle,
      changed: () => undefined,
      open: async (given, create) => {
        access.push(given);
        if (create) brain.project = true;
        return brain.project ? brain : null;
      },
      doors,
    });
    return { cloud, access };
  }

  beforeEach(async () => {
    doors = new FakeDoors(() => brain.calls);
    await core.close();
    // Vercel is connected too: the brain goes where Settings sends new cloud machines.
    await open({ cloudAgent37: async () => AGENT37, cloudService: async () => "agent37" as const, cloudBrainBundle: bundle, cloudBrainDoors: doors });
  });

  it("sets up where new cloud machines go, with no region and no door, its threads in the size Settings chose", async () => {
    expect((await rpc("cloud.brain.create", {})).state).toBe("setting-up");
    await vi.waitFor(async () => expect((await status()).state).toBe("ready"));
    expect(brain.access[0]).toEqual({ service: "agent37", key: AGENT37.key });
    expect(brain.calls[0]).toBe("provision v1 archive undefined");
    expect(brain.wakeInputs[0]).toEqual({ key: brain.key, name: "Cloud", threadSize: { cpu: 4, memory: 16 } });
    expect(stored()).toMatchObject({ service: "agent37" });
    expect(stored()).not.toHaveProperty("teamId");
    await rpc("cloud.brain.wake", {});
    expect(await status()).toMatchObject({ state: "ready", service: "agent37", region: null, door: null });
    await rpc("cloud.brain.remove", {});
    expect(brain.calls.at(-1)).toBe("remove");
    expect(await status()).toEqual({ state: "none", error: null });
    expect([doors.opens, doors.removes]).toEqual([[], []]);
  });

  it("says why the brain did not start without the Agent37 key", async () => {
    brain.wakes = { state: "failed", detail: `Exited: key ${AGENT37.key}` };
    await rpc("cloud.brain.create", {});
    await vi.waitFor(async () => expect((await status()).state).toBe("incomplete"));
    const shown = await status();
    expect(shown).toMatchObject({ state: "incomplete", service: "agent37", region: null, error: expect.stringContaining("[redacted]") });
    expect(JSON.stringify(shown)).not.toContain(AGENT37.key);
  });

  it("keeps the service it was made on when new cloud machines go to the other", async () => {
    let service: CloudService = "vercel";
    const { cloud, access } = cloudBrain(() => service);
    await cloud.create("sin1");
    await vi.waitFor(async () => expect((await cloud.status()).state).toBe("ready"));
    service = "agent37";
    await cloud.wake();
    expect(await cloud.status()).toMatchObject({ state: "ready", service: "vercel", region: "sin1" });
    expect(new Set(access.map((given) => given.service))).toEqual(new Set(["vercel"]));
    expect(brain.wakeInputs.at(-1)).toEqual({ key: brain.key, name: "Cloud", threadVcpus: 4 });
  });

  it("is dialed only while its machine runs, since any request to its address wakes it; a Vercel brain's dial never needs a look", async () => {
    const { cloud } = cloudBrain(() => "agent37");
    await cloud.create();
    await vi.waitFor(async () => expect((await cloud.status()).state).toBe("ready"));
    expect(await cloud.dialable()).toBe(true);
    brain.state = "stopped";
    expect(await cloud.dialable()).toBe(false);
    // The same stand-in machine, made again on Vercel.
    brain.state = "missing";
    const vercel = cloudBrain(() => "vercel").cloud;
    await vercel.create("sin1");
    await vi.waitFor(async () => expect((await vercel.status()).state).toBe("ready"));
    brain.state = "stopped";
    const looks = brain.calls.length;
    expect(await vercel.dialable()).toBe(true);
    expect(brain.calls.length).toBe(looks);
  });

  it("sets up on the service chosen at setup, whatever new cloud threads run on", async () => {
    await core.close();
    await open({ cloudAgent37: async () => AGENT37, cloudService: async () => "vercel" as const, cloudBrainBundle: bundle, cloudBrainDoors: doors });
    expect((await rpc("cloud.brain.create", { service: "agent37" })).state).toBe("setting-up");
    await vi.waitFor(async () => expect((await status()).state).toBe("ready"));
    expect(new Set(brain.access.map((given) => given.service))).toEqual(new Set(["agent37"]));
    expect(await status()).toMatchObject({ state: "ready", service: "agent37", region: null });
    expect(stored()).toMatchObject({ service: "agent37" });
  });

  it("keeps a brain this Mac has no key for found on the chosen service, and removes it from there", async () => {
    await core.close();
    await open({ cloudAgent37: async () => AGENT37, cloudService: async () => "vercel" as const, cloudBrainBundle: bundle, cloudBrainDoors: doors });
    brain.project = true;
    brain.state = "stopped";
    expect(await rpc("cloud.brain.create", { service: "agent37" })).toEqual({ state: "elsewhere", service: "agent37", error: null });
    expect(await status()).toEqual({ state: "elsewhere", service: "agent37", error: null });
    expect(await rpc("cloud.brain.remove", {})).toEqual({ state: "none", error: null });
    expect(brain.calls.at(-1)).toBe("remove");
    expect(brain.access.at(-1)).toEqual({ service: "agent37", key: AGENT37.key });
    expect(doors.removes).toEqual([]);
  });

  it("asks for a region only of a brain on Vercel", async () => {
    await expect(cloudBrain(() => "vercel").cloud.create()).rejects.toThrow("Choose a region for the cloud brain.");
  });
});
