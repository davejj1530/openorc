import {
  BRAIN_PROJECT,
  BrainMachine,
  BrainRefused,
  BrainUnavailable,
  brainKeyFrom,
  brainKeyText,
  brainVersionNewer,
  newBrainKey,
  sealHandover,
  type BrainAccess,
  type BrainControlResults,
  type BrainKey,
  type BrainMachineStatus,
  type DoorBundle,
  type HandoverClaudeAccount,
} from "@openorc/cloud";
import { claudeAccounts, projects, redact, type Db } from "@openorc/db";
import type { BrainRegion, CloudBrainMachine, CloudBrainPairing, CloudBrainProject, CloudBrainStatus, CloudBrainStep, Project } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import { BrainDoorKeeper, vercelDoors, type BrainDoors } from "./cloud-brain-door.js";
import { copyBranch, keptOwn, moved, seen, sendProject, switchedOn, type BrainProject } from "./cloud-brain-projects.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/** What phones show for the brain. */
const BRAIN_NAME = "Cloud";
const storageError = "Cannot access protected storage for the cloud brain. Unlock your OS keychain and retry.";
const unavailable = "The cloud brain isn't available in this build.";
const hasThreads = "It has threads on the cloud brain.";

/** A brain this build can install. Read only when installing it, since it is tens of megabytes. */
export interface BrainBundleSource {
  version: string;
  read(): Promise<Buffer>;
  /** The door this build deploys beside the brain, which a paired phone knocks on to wake it. */
  door?: DoorBundle;
}

/** The parts of BrainMachine this uses; tests pass a stand-in. */
export type BrainMachineLike = Pick<BrainMachine, "status" | "provision" | "wake" | "control" | "importProject" | "remove">;

/** The brain's machine on a team. Its project is made only when `create`; otherwise a team without one has none. */
export type OpenBrainMachine = (access: BrainAccess, create: boolean) => Promise<BrainMachineLike | null>;
const openMachine: OpenBrainMachine = (access, create) => (create ? BrainMachine.connect(access) : BrainMachine.find(access));

/** What the brain last took of one Claude account, to name it in Settings and to tell a change since. */
interface Sent {
  id: string;
  name: string;
  default: boolean;
  /** When the token sent was made or pasted. */
  tokenAt: number;
}

/** Kept in protected storage. The key alone opens the brain's secrets, so it is saved before anything is made. */
interface Stored {
  key: string;
  teamId: string;
  region: BrainRegion;
  /** The brain's public host, once it has started. */
  address: string | null;
  /** The brain has started once; until then setting up again keeps this key and region. */
  ready: boolean;
  claude: Sent[];
  /** The brain installed on its machine, as this Mac last installed or found it. Records from before lack it. */
  version?: string;
  /** The projects switched on for it. Records from before lack them. */
  projects?: BrainProject[];
}

type Activity = { kind: "setting-up"; step: CloudBrainStep } | { kind: "removing" } | { kind: "waking" } | { kind: "sending" } | { kind: "updating" };

/** What a ready brain shows it is at while each operation runs. */
const WORKING: Record<Activity["kind"], Extract<CloudBrainStatus, { state: "ready" }>["working"]> = {
  "setting-up": null,
  removing: null,
  waking: "waking",
  sending: "sending",
  updating: "updating",
};

const MACHINE: Record<BrainMachineStatus["state"], CloudBrainMachine | "missing"> = {
  running: "awake",
  stopped: "asleep",
  starting: "starting",
  stopping: "stopping",
  failed: "failed",
  missing: "missing",
};

const sameSent = (a: Sent[], b: Sent[]) => JSON.stringify(a) === JSON.stringify(b);

export interface CloudBrainDeps {
  db: Db;
  store: ProtectedSecretStore | undefined;
  tokens: Pick<ClaudeCloudTokens, "status" | "token">;
  /** The Vercel connection the brain is made with. The brain keeps its own project on the team. */
  vercel: () => Promise<{ token: string; teamId: string; vcpus?: number } | null>;
  bundle: (() => Promise<BrainBundleSource | null>) | undefined;
  changed: () => void;
  open?: OpenBrainMachine;
  doors?: BrainDoors;
  /** The brain's project and its door's; the product's own unless given, as for a QA brain kept apart. */
  projects?: { brain?: string; door?: string };
}

/**
 * The cloud brain as this Mac sets it up, keeps it on this build's brain and hands it sign-ins: its key, team, region,
 * installed version and what it was last sent, in protected storage; the machine itself through BrainMachine. One
 * operation runs at a time; the status answers between them and never wakes the brain.
 */
export class CloudBrain {
  private pending: Promise<unknown> = Promise.resolve();
  /** Undefined until read; null when no brain is set up. */
  private cache: Stored | null | undefined;
  private activity: Activity | null = null;
  private error: string | null = null;
  /** The team a brain this Mac has no key for was found in, when setting up. */
  private elsewhere: string | null = null;
  private connected: { key: string; machine: BrainMachineLike } | null = null;
  /** The Mac project whose copy is on its way to the brain. */
  private sendingProject: string | null = null;
  /** The version the brain ran when this Mac last woke it. */
  private running: string | null = null;
  private readonly door: BrainDoorKeeper;

  constructor(private readonly deps: CloudBrainDeps) {
    this.door = new BrainDoorKeeper({ doors: deps.doors ?? vercelDoors, project: deps.projects?.door, changed: () => this.changed(), scrub: (error) => this.scrub(error) });
  }

  async status(): Promise<CloudBrainStatus> {
    if (this.activity?.kind === "removing") return { state: "removing" };
    let stored: Stored | null;
    try {
      stored = await this.read();
    } catch (error) {
      return { state: "none", error: words(error) };
    }
    if (!stored) {
      if (await this.stillElsewhere()) return { state: "elsewhere", error: this.error };
      return (await this.deps.bundle?.()) ? { state: "none", error: this.error } : { state: "unavailable" };
    }
    if (this.activity?.kind === "setting-up") return { state: "setting-up", region: stored.region, step: this.activity.step };
    if (!stored.ready) return { state: "incomplete", region: stored.region, error: this.error };
    const { machine, error } = await this.look(stored);
    if (machine === "missing") return { state: "incomplete", region: stored.region, error: this.error ?? "The cloud brain's machine is gone." };
    const working = this.activity ? WORKING[this.activity.kind] : null;
    const behind = !sameSent((await this.claude().catch(() => [])).map(sent), stored.claude);
    const claude = stored.claude.map((account) => account.name);
    return { state: "ready", region: stored.region, machine, claude, behind, working, door: this.door.status(), error: this.error ?? error };
  }

  /**
   * The region of the brain this Mac set up, null without one. Never waits for an operation: one running asks the
   * Vercel connection, which asks this.
   */
  async region(): Promise<BrainRegion | null> {
    return (await this.read().catch(() => null))?.region ?? null;
  }

  /** This Mac's projects, Workspace aside, and which the brain has a copy of. Never wakes the brain. */
  async projects(): Promise<CloudBrainProject[]> {
    const records = new Map(((await this.read().catch(() => null))?.projects ?? []).map((record) => [record.id, record]));
    const listed = projects.list(this.deps.db);
    // A project removed from this Mac's list keeps its copy until switched off here.
    const unlisted = [...records.keys()].filter((id) => !listed.some((project) => project.id === id)).flatMap((id) => projects.get(this.deps.db, id) ?? []);
    return Promise.all(
      [...listed, ...unlisted].map(async (project) => {
        const record = records.get(project.id);
        const shown = { on: record !== undefined, blocked: await blocked(project, record), sending: this.sendingProject === project.id, kept: record ? keptOwn(record) : false };
        return { id: project.id, name: project.name, ...shown, error: record?.error ?? null };
      }),
    );
  }

  /**
   * Switched on, the project is sent to the brain, woken for it, and kept fresh whenever this Mac wakes it after. Switched
   * off, the brain removes its copy unless it has threads in it. A failure shows in the status.
   */
  async setProject(id: string, on: boolean): Promise<void> {
    await this.run({ kind: "waking" }, async () => {
      const stored = await this.stored();
      const record = stored.projects?.find((project) => project.id === id);
      if (on === (record !== undefined)) return;
      if (on) {
        const project = projects.get(this.deps.db, id);
        const copy = project ? await copyBranch(project) : { blocked: "That project is not on this Mac." };
        if ("blocked" in copy) throw new Error(copy.blocked);
        await this.write({ ...stored, projects: [...(stored.projects ?? []), switchedOn(id, copy.branch)] });
        await this.wakeUp(await this.machine());
        return;
      }
      if (!record) return;
      if (record.threads) throw new Error(hasThreads);
      const machine = await this.machine();
      await this.wakeUp(machine);
      const { removed, threads } = await machine.control({ op: "remove-project", source: id });
      if (!removed) return this.saveProjects([{ ...record, threads }]);
      const now = await this.stored();
      await this.write({ ...now, projects: now.projects?.filter((project) => project.id !== id) });
    }).catch(() => undefined);
  }

  /**
   * Makes the brain in the region and sets it up in the background, its progress in the status. Again after a failure,
   * or on a brain that is set up, it keeps the key and region it has and installs this build's brain, unless the
   * machine has a newer one.
   */
  async create(region: BrainRegion): Promise<void> {
    const source = await this.serialize(() => this.prepare(region)).catch(async (error: unknown) => {
      throw new Error(await this.scrub(error));
    });
    if (source) void this.run({ kind: "setting-up", step: "machine" }, () => this.setUp(source)).catch(() => undefined);
  }

  /** Starts the brain unless it runs, and sends Claude sign-ins that changed. A failure shows in the status. */
  async wake(): Promise<void> {
    await this.run({ kind: "waking" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      if (await this.behind()) await this.send(machine);
    }).catch(() => undefined);
  }

  /** Wakes the brain and asks it for a phone pairing code. A failure shows in the status too, since it can end setup. */
  pair(): Promise<CloudBrainPairing> {
    return this.run({ kind: "waking" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      const { url, expiresAt } = await machine.control({ op: "pair" });
      return { url, expiresAt };
    });
  }

  /** Sends the Claude sign-ins, waking the brain. A failure shows in the status. */
  async handover(): Promise<void> {
    await this.run({ kind: "sending" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      await this.send(machine);
    }).catch(() => undefined);
  }

  /** A Claude cloud token was saved or removed on this Mac: a brain that is set up takes the new list, woken for it. */
  claudeChanged(): void {
    void this.serialize(async () => {
      if (!(await this.read())?.ready || !(await this.behind())) return;
      await this.tracked({ kind: "sending" }, async () => {
        const machine = await this.machine();
        await this.wakeUp(machine);
        await this.send(machine);
      });
    }).catch(() => undefined);
  }

  /** Once this Mac's core has started: the door is brought to this build, as after an update. Wakes nothing. */
  opened(): void {
    this.refreshDoor();
  }

  /** The Vercel connection's token or size changed: the door takes them, since it wakes the brain with them. */
  vercelChanged(): void {
    this.refreshDoor();
  }

  /**
   * Forgets the Vercel connection with `forget`, once the door's deployments and its copy of the token are gone. One
   * step, so no queued look opens the door again in between. Throws when they could not go, and the connection stays.
   */
  disconnect(forget: () => Promise<unknown>): Promise<void> {
    return this.serialize(async () => {
      const stored = await this.read();
      const vercel = await this.deps.vercel();
      if (stored && vercel) await this.door.close({ token: vercel.token, teamId: stored.teamId });
      await forget();
    });
  }

  /** Deletes the brain's door, then the brain, its disk and its thread sandboxes, then forgets its key. A failure shows in the status. */
  async remove(): Promise<void> {
    await this.run({ kind: "removing" }, async () => {
      const stored = await this.read();
      const vercel = await this.vercel();
      const teamId = stored?.teamId ?? vercel.teamId;
      // First, so nothing wakes the brain while it goes.
      await this.door.remove({ token: vercel.token, teamId });
      await (await this.open({ token: vercel.token, teamId }, false))?.remove();
      await this.write(null);
      this.elsewhere = null;
    }).catch(() => undefined);
  }

  /** The checks a Set up click hears at once. Null when there is nothing to set up in the background. */
  private async prepare(region: BrainRegion) {
    if (this.activity?.kind === "setting-up") return null;
    const source = await this.deps.bundle?.();
    if (!source) throw new Error(unavailable);
    const vercel = await this.vercel();
    if (!(await this.read())) {
      const machine = await this.open({ token: vercel.token, teamId: vercel.teamId }, false);
      if (machine && (await machine.status()).state !== "missing") {
        this.elsewhere = vercel.teamId;
        this.changed();
        return null;
      }
      // Saved before anything is made, so whatever setup leaves behind opens with a key this Mac keeps.
      await this.write({ key: brainKeyText(newBrainKey()), teamId: vercel.teamId, region, address: null, ready: false, claude: [] });
    }
    this.elsewhere = null;
    this.activity = { kind: "setting-up", step: "machine" };
    this.changed();
    return source;
  }

  private async setUp(source: BrainBundleSource): Promise<void> {
    const machine = await this.machine(true);
    const { installed } = await machine.provision({ version: source.version, archive: await source.read() }, { region: (await this.stored()).region });
    await this.write({ ...(await this.stored()), version: installed });
    this.step("start");
    await this.startInstalled(machine);
    this.step("sign-ins");
    await this.send(machine);
    this.refreshAfter();
  }

  private step(step: CloudBrainStep): void {
    this.activity = { kind: "setting-up", step };
    this.changed();
  }

  /**
   * Starts the brain unless it runs, on this build's brain when that is newer than the one its machine has: installed
   * first, so the brain starts on it. Never installs an older one; a failed update leaves the brain on what it has.
   */
  private async wakeUp(machine: BrainMachineLike): Promise<void> {
    await this.update(machine).catch(async (error: unknown) => {
      this.error = `The cloud brain could not be updated. ${await this.scrub(error)}`;
    });
    await this.startInstalled(machine);
    this.refreshAfter();
  }

  /** Once the operation that woke the brain ends, so the brain runs this build's version first and a pairing waits on nothing. */
  private refreshAfter(): void {
    void this.serialize(() => this.refreshProjects()).catch(() => undefined);
    this.refreshDoor();
  }

  /** Queued behind what runs. Never wakes the brain; costs one look at the door when it is current. */
  private refreshDoor(): void {
    void this.serialize(async () => {
      const door = (await this.deps.bundle?.())?.door;
      if (!door) return;
      const stored = await this.read();
      const vercel = await this.deps.vercel();
      if (!stored?.ready || !vercel) return;
      const access = { token: vercel.token, teamId: stored.teamId };
      const project = this.deps.projects?.brain ?? BRAIN_PROJECT;
      await this.door.open(access, { ...(await this.wakeInput(stored)), vercel: { ...access, project }, revoked: [] }, door);
    }).catch(() => undefined);
  }

  /** What a wake hands the brain, the same for this Mac's own wake and its door's. */
  private async wakeInput(stored: Stored): Promise<{ key: BrainKey; name: string; threadVcpus?: number }> {
    const vcpus = (await this.deps.vercel())?.vcpus;
    return { key: brainKeyFrom(stored.key), name: BRAIN_NAME, ...(vcpus ? { threadVcpus: vcpus } : {}) };
  }

  /**
   * Hears which copies the brain has, then sends each project switched on whose branch moved since the brain's copy
   * took it, one at a time. Never wakes the brain: one that went to sleep meanwhile is refreshed at its next wake.
   */
  private async refreshProjects(): Promise<void> {
    const stored = await this.read();
    if (!stored?.ready || !stored.projects?.length) return;
    if (await this.behindUpdate(stored)) return;
    const machine = await this.machine();
    let copies: BrainControlResults["projects"]["copies"];
    try {
      ({ copies } = await machine.control({ op: "projects" }));
    } catch (error) {
      if (error instanceof BrainUnavailable) return;
      const why = await this.scrub(error);
      return this.saveProjects(stored.projects.map((record) => ({ ...record, error: why })));
    }
    const records = stored.projects.map((record) => seen(record, copies));
    await this.saveProjects(records);
    for (const record of records) {
      const project = projects.get(this.deps.db, record.id);
      if (!project || !(await moved(project, record))) continue;
      const next = await this.sending(project, () => sendProject(machine, project, record)).catch(async (error: unknown) =>
        error instanceof BrainUnavailable ? null : { ...record, error: await this.scrub(error) },
      );
      if (!next) return;
      await this.saveProjects([next]);
    }
  }

  /**
   * The brain runs an older version than its machine has or this build carries, as one busy when this Mac updated it:
   * it may not know the requests projects need. The build's version counts too, since a stop that went unanswered
   * records what the brain ran as installed.
   */
  private async behindUpdate(stored: Stored): Promise<boolean> {
    const running = this.running;
    if (!running) return false;
    const versions = [stored.version, (await this.deps.bundle?.())?.version];
    return versions.some((version) => version !== undefined && brainVersionNewer(version, running));
  }

  /** Each record replaces the one with its id, unless switched off meanwhile. */
  private async saveProjects(records: BrainProject[]): Promise<void> {
    const stored = await this.stored();
    await this.write({ ...stored, projects: stored.projects?.map((each) => records.find((record) => record.id === each.id) ?? each) });
    this.changed();
  }

  private async sending<T>(project: Project, work: () => Promise<T>): Promise<T> {
    this.sendingProject = project.id;
    this.changed();
    try {
      return await work();
    } finally {
      this.sendingProject = null;
      this.changed();
    }
  }

  /**
   * Starts the brain unless it runs. A brain running an older one than its machine has restarts onto it unless that
   * would cut work short, else at its next start.
   */
  private async startInstalled(machine: BrainMachineLike): Promise<void> {
    const running = await this.start(machine);
    const installed = (await this.stored()).version;
    if (!installed || !brainVersionNewer(installed, running)) return;
    await this.updating(async () => {
      try {
        await machine.control({ op: "stop-for-update" });
      } catch (error) {
        // Work runs, or a brain from before such stops: it starts on the new one next time. Any other failure may have
        // stopped it, so it starts again.
        if (error instanceof BrainRefused) return;
      }
      const restarted = await this.start(machine);
      // What a fresh start runs is what the machine has, behind the record once its disk went back to an older
      // snapshot. Recorded, the next wake installs this build's brain again.
      if (restarted !== installed) await this.write({ ...(await this.stored()), version: restarted });
    });
  }

  /** Installs this build's brain when it was built after the one on the brain's machine. */
  private async update(machine: BrainMachineLike): Promise<void> {
    const stored = await this.stored();
    const source = await this.deps.bundle?.();
    if (!source || (stored.version !== undefined && !brainVersionNewer(source.version, stored.version))) return;
    // Installing makes a machine that is gone, empty; waking it says it needs setting up again instead.
    if ((await machine.status()).state === "missing") return;
    await this.updating(async () => {
      const { installed } = await machine.provision({ version: source.version, archive: await source.read() }, { region: stored.region });
      await this.write({ ...(await this.stored()), version: installed });
    });
  }

  /** Shows the brain updating while `work` runs, then what the operation showed before. Setup shows its own steps. */
  private async updating(work: () => Promise<void>): Promise<void> {
    const before = this.activity;
    if (before?.kind === "setting-up") return work();
    this.activity = { kind: "updating" };
    this.changed();
    try {
      await work();
    } finally {
      this.activity = before;
      this.changed();
    }
  }

  /** Starts the brain unless it runs, and says which version runs. */
  private async start(machine: BrainMachineLike): Promise<string> {
    const stored = await this.stored();
    const result = await machine.wake(await this.wakeInput(stored));
    switch (result.state) {
      case "ready":
        if (!stored.ready || stored.address !== result.address) await this.write({ ...stored, ready: true, address: result.address });
        this.running = result.version;
        return result.version;
      case "needs-provision":
        await this.write({ ...stored, ready: false });
        throw new Error(`The cloud brain needs setting up again. ${result.detail}`);
      case "wrong-key":
        throw new Error("This Mac's key does not open the cloud brain. Remove it to set up a new one.");
      case "failed":
        throw new Error(`The cloud brain did not start. ${result.detail}`);
    }
  }

  /**
   * Hands over every Claude account with a cloud token, so the brain drops any other. Codex is not sent: a ChatGPT
   * login's refresh token works once, so the Mac's cloud login and a copy on the brain would sign each other out.
   */
  private async send(machine: BrainMachineLike): Promise<void> {
    const stored = await this.stored();
    const accounts = await this.claude();
    const handed: HandoverClaudeAccount[] = accounts.map(({ id, name, default: isDefault, token }) => ({ id, name, default: isDefault, token }));
    await machine.control(sealHandover(brainKeyFrom(stored.key), { claude: { accounts: handed } }));
    await this.write({ ...(await this.stored()), claude: accounts.map(sent) });
  }

  private async behind(): Promise<boolean> {
    const stored = await this.read();
    return stored !== null && !sameSent((await this.claude()).map(sent), stored.claude);
  }

  /** Every enabled Claude account with a cloud token, the default marked. One turned off here does not run there either. */
  private async claude(): Promise<(Sent & { token: string })[]> {
    const access = await this.deps.tokens.status();
    const defaultId = claudeAccounts.defaultId(this.deps.db);
    const accounts: (Sent & { token: string })[] = [];
    for (const { id, name } of claudeAccounts.list(this.deps.db).filter((account) => account.enabled)) {
      const tokenAt = access[id]?.createdAt;
      const token = tokenAt == null ? null : await this.deps.tokens.token(id);
      if (token && tokenAt != null) accounts.push({ id, name, default: id === defaultId, tokenAt, token });
    }
    return accounts;
  }

  /** How Vercel reports the brain's machine; null with a reason when it cannot be asked. */
  private async look(stored: Stored): Promise<{ machine: CloudBrainMachine | "missing" | null; error: string | null }> {
    try {
      const vercel = await this.vercel();
      const machine = await this.open({ token: vercel.token, teamId: stored.teamId }, false);
      return { machine: machine ? MACHINE[(await machine.status()).state] : "missing", error: null };
    } catch (error) {
      return { machine: null, error: `Could not ask Vercel about the cloud brain. ${await this.scrub(error)}` };
    }
  }

  private async vercel(): Promise<{ token: string; teamId: string; vcpus?: number }> {
    const vercel = await this.deps.vercel();
    if (!vercel) throw new Error("Connect Vercel and choose a team first.");
    return vercel;
  }

  /**
   * The machine of the brain this Mac set up, on the team it was made on. Only setup makes the brain's project: a brain
   * whose project is gone needs setting up again.
   */
  private async machine(create = false): Promise<BrainMachineLike> {
    const stored = await this.stored();
    const machine = await this.open({ token: (await this.vercel()).token, teamId: stored.teamId }, create);
    if (machine) return machine;
    await this.write({ ...stored, ready: false });
    throw new Error("The cloud brain's machine is gone.");
  }

  /** One connection per token and team, since connecting looks up the brain's project. */
  private async open(access: BrainAccess, create: boolean): Promise<BrainMachineLike | null> {
    const key = `${access.teamId}\n${access.token}`;
    if (this.connected?.key === key) return this.connected.machine;
    const project = this.deps.projects?.brain;
    const machine = await (this.deps.open ?? openMachine)(project ? { ...access, project } : access, create);
    if (machine) this.connected = { key, machine };
    return machine;
  }

  /** Whether the brain found when setting up is still there, on the team Settings has now. */
  private async stillElsewhere(): Promise<boolean> {
    if (!this.elsewhere) return false;
    try {
      const vercel = await this.deps.vercel();
      const machine = vercel?.teamId === this.elsewhere ? await this.open({ token: vercel.token, teamId: vercel.teamId }, false) : null;
      if (!machine || (await machine.status()).state === "missing") this.elsewhere = null;
    } catch {
      // Vercel could not be asked: what was found stays until it can.
    }
    return this.elsewhere !== null;
  }

  /** One operation at a time, shown in the status while it runs, its failure kept for Settings. */
  private run<T>(activity: Activity, work: () => Promise<T>): Promise<T> {
    return this.serialize(() => this.tracked(activity, work));
  }

  private async tracked<T>(activity: Activity, work: () => Promise<T>): Promise<T> {
    this.activity = activity;
    this.error = null;
    this.changed();
    try {
      return await work();
    } catch (error) {
      this.error = await this.scrub(error);
      throw new Error(this.error);
    } finally {
      this.activity = null;
      this.changed();
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private changed(): void {
    this.deps.changed();
  }

  /** An error's words without the Vercel token or the brain key, whatever passed them on. */
  private async scrub(error: unknown): Promise<string> {
    const secrets = [(await this.deps.vercel().catch(() => null))?.token, this.cache?.key];
    return secrets.reduce<string>((text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text), redact(words(error)).text);
  }

  private async stored(): Promise<Stored> {
    const stored = await this.read();
    if (!stored) throw new Error("The cloud brain is not set up.");
    return stored;
  }

  private async read(): Promise<Stored | null> {
    if (this.cache !== undefined) return this.cache;
    if (!this.deps.store) return (this.cache = null);
    let raw: string | null;
    try {
      raw = await this.deps.store.load();
    } catch {
      throw new Error(storageError);
    }
    try {
      this.cache = raw ? (JSON.parse(raw) as Stored) : null;
    } catch {
      // JSON.parse's message quotes what it read, which holds the key.
      throw new Error(storageError);
    }
    return this.cache;
  }

  private async write(next: Stored | null): Promise<void> {
    try {
      if (!this.deps.store) throw new Error(storageError);
      await this.deps.store.save(next ? JSON.stringify(next) : "");
    } catch {
      throw new Error(storageError);
    }
    this.cache = next;
  }
}

/** Why a project's switch cannot move now: on, the brain has threads in its copy; off, it cannot have a copy. */
async function blocked(project: Project, record: BrainProject | undefined): Promise<string | null> {
  if (record) return record.threads ? hasThreads : null;
  const copy = await copyBranch(project);
  return "blocked" in copy ? copy.blocked : null;
}

function sent({ id, name, default: isDefault, tokenAt }: Sent): Sent {
  return { id, name, default: isDefault, tokenAt };
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
