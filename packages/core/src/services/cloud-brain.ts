import { randomUUID } from "node:crypto";
import {
  BRAIN_PROJECT,
  BrainRefused,
  BrainUnavailable,
  brainKeyFrom,
  brainKeyText,
  brainVersionNewer,
  newBrainKey,
  sealHandover,
  type Agent37Connection,
  type AgentVersions,
  type BrainAccess,
  type BrainControlResults,
  type BrainKey,
  type HandoverClaudeAccount,
  type HandoverCodexLogin,
  type WakeInput,
} from "@openorc/cloud";
import { projects, redact, type Db } from "@openorc/db";
import type {
  BrainRegion,
  CloudBrainCost,
  CloudBrainMachine,
  CloudBrainPairing,
  CloudBrainProject,
  CloudBrainSignIns,
  CloudBrainStatus,
  CloudBrainStep,
  CloudService,
  Project,
} from "@openorc/protocol";
import { BrainCosts } from "./cloud-brain-cost.js";
import { openMachine, shownMachine, type BrainBundleSource, type BrainMachineLike, type OpenBrainMachine } from "./cloud-brain-machine.js";
import { BrainPhones } from "./cloud-brain-phones.js";
import { SERVICE_NAMES, accessHere, accountOf, brainConnections, placeOf, provisionAt, reach, regionOf, serviceOf, threadCloud, threadSizes, type BrainConnections } from "./cloud-brain-place.js";
import { BrainRecord, type StoredBrain } from "./cloud-brain-record.js";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import { BrainDoorKeeper, vercelDoors, type BrainDoors } from "./cloud-brain-door.js";
import { anyMoved, confirmCurrent, copyBranch, failedAt, freshCopy, hasThreads, projectsShown, seen, stale, switchedOn, type BrainProject } from "./cloud-brain-projects.js";
import { claudeToSend, sameSent, sent, type Sent } from "./cloud-brain-claude.js";
import { NO_SIGN_INS, claimsSignIns, heardSignIns, signInChanges, signInsView, switchGitHub, type CloudSource, type SignInRecord, type SignInSources } from "./cloud-brain-signins.js";
import { alignAgentVersions } from "./cloud-brain-versions.js";
import { apiKeyAuth } from "./codex-cloud-login.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/** What phones show for the brain. */
const BRAIN_NAME = "Cloud";
const unavailable = "The cloud brain isn't available in this build.";

type Activity = { kind: "setting-up"; step: CloudBrainStep } | { kind: "removing" } | { kind: "waking" } | { kind: "sending" } | { kind: "updating" };

/** What a ready brain shows it is at while each operation runs. */
const WORKING: Partial<Record<Activity["kind"], Extract<CloudBrainStatus, { state: "ready" }>["working"]>> = { waking: "waking", sending: "sending", updating: "updating" };

export interface CloudBrainDeps {
  db: Db;
  store: ProtectedSecretStore | undefined;
  tokens: Pick<ClaudeCloudTokens, "status" | "token">;
  /** The Vercel connection a brain on Vercel is made with. The brain keeps its own project on the team. */
  vercel: BrainConnections["vercel"];
  /** The Agent37 connection a brain on Agent37 is made with; none unless given. */
  agent37?: () => Promise<Agent37Connection | null>;
  /** The service a new brain is made on; Vercel while it is connected, unless given. */
  service?: () => Promise<CloudService | null>;
  bundle: (() => Promise<BrainBundleSource | null>) | undefined;
  changed: () => void;
  open?: OpenBrainMachine;
  doors?: BrainDoors;
  /** The brain's project and its door's; the product's own unless given, as for a QA brain kept apart. */
  projects?: { brain?: string; door?: string };
  /** This Mac's sign-ins besides Claude's that the brain is kept on; none unless given. */
  signIns?: SignInSources;
  /** This Mac's agent CLI versions, which the brain is brought to at each wake; none unless given. */
  agentVersions?: () => Promise<AgentVersions>;
}

/**
 * The cloud brain as this Mac sets it up, keeps it on this build's brain and hands it sign-ins: its key, team, region,
 * installed version and what it was last sent, in protected storage; the machine itself through BrainMachine. One
 * operation runs at a time; the status answers between them and never wakes the brain.
 */
export class CloudBrain {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly record: BrainRecord;
  private activity: Activity | null = null;
  private error: string | null = null;
  /** The account a brain this Mac has no key for was found in, when setting up. */
  private elsewhere: { service: CloudService; account: string } | null = null;
  private connected: { key: string; machine: BrainMachineLike } | null = null;
  /** The Mac project whose copy is on its way to the brain. */
  private sendingProject: string | null = null;
  /** The version the brain ran when this Mac last woke it. */
  private running: string | null = null;
  /** A Codex login made for the brain, or its sign-out, shown at once while it waits its turn for the record. */
  private codexWaiting: HandoverCodexLogin | null | undefined = undefined;
  private readonly door: BrainDoorKeeper;
  /** The phones paired with it, as this Mac last heard them. */
  readonly phones: BrainPhones;
  private readonly costs = new BrainCosts();
  private stuck = new Map<string, string | null>();

  private readonly connections: BrainConnections;

  constructor(private readonly deps: CloudBrainDeps) {
    this.connections = brainConnections(deps);
    this.record = new BrainRecord(deps.store);
    this.door = new BrainDoorKeeper({ doors: deps.doors ?? vercelDoors, project: deps.projects?.door, changed: () => this.changed(), scrub: (error) => this.scrub(error) });
    this.phones = new BrainPhones({ db: deps.db, machine: (wake, work) => this.withMachine(wake, work), changed: () => this.changed() });
  }

  async status(): Promise<CloudBrainStatus> {
    if (this.activity?.kind === "removing") return { state: "removing" };
    let stored: StoredBrain | null;
    try {
      stored = await this.record.read();
    } catch (error) {
      return { state: "none", error: words(error) };
    }
    if (!stored) {
      const elsewhere = await this.stillElsewhere();
      if (elsewhere) return { state: "elsewhere", service: elsewhere, error: this.error };
      return (await this.deps.bundle?.()) ? { state: "none", error: this.error } : { state: "unavailable" };
    }
    const where = { service: serviceOf(stored), region: regionOf(stored) };
    if (this.activity?.kind === "setting-up") return { state: "setting-up", ...where, step: this.activity.step };
    if (!stored.ready) return { state: "incomplete", ...where, error: this.error };
    const { machine, error } = await this.look(stored);
    if (machine === "missing") return { state: "incomplete", ...where, error: this.error ?? "The cloud brain's machine is gone." };
    const working = (this.activity && WORKING[this.activity.kind]) ?? null;
    const behind = !sameSent((await this.claude().catch(() => [])).map(sent), stored.claude);
    const claude = stored.claude.map((account) => account.name);
    const threads = (stored.projects ?? []).reduce((sum, record) => sum + record.threads, 0);
    return { state: "ready", ...where, machine, claude, behind, working, door: this.door.status(), threads, error: this.error ?? error };
  }

  /**
   * The region of the brain this Mac set up, null without one or on Agent37. Never waits for an operation: one running
   * asks the Vercel connection, which asks this.
   */
  async region(): Promise<BrainRegion | null> {
    const stored = await this.record.read().catch(() => null);
    return stored && regionOf(stored);
  }

  /** Installing this build's brain on its machine, as a wake does first after an update. */
  get installingUpdate(): boolean {
    return this.activity?.kind === "updating";
  }

  /** A brain is set up, or setting up, from this Mac. */
  async exists(): Promise<boolean> {
    return (await this.record.read().catch(() => null)) !== null;
  }

  /**
   * Whether dialing the brain now leaves it as it is. A Vercel brain's address refuses a dial while it sleeps; any
   * request to an Agent37 brain's wakes it, so that one is dialed only while its machine runs. Never wakes it.
   */
  async dialable(): Promise<boolean> {
    const stored = await this.record.read().catch(() => null);
    if (stored?.service !== "agent37") return true;
    const machine = await this.reach(stored)
      .then((access) => this.open(access, false))
      .catch(() => null);
    return (await machine?.status().catch(() => null))?.state === "running";
  }

  /** What moving threads needs of the brain this Mac set up, once it has started; null before. Never wakes it. */
  async moves(): Promise<{ address: string; key: BrainKey; linkKey: string | null; projects: BrainProject[] } | null> {
    const stored = await this.record.read().catch(() => null);
    return stored?.ready && stored.address ? { address: stored.address, key: brainKeyFrom(stored.key), linkKey: stored.linkKey ?? null, projects: stored.projects ?? [] } : null;
  }

  /** `work` on the brain's machine, in turn with every other operation; `wake` starts the brain first, as Wake does. */
  withMachine<T>(wake: boolean, work: (machine: BrainMachineLike) => Promise<T>): Promise<T> {
    if (!wake) return this.serialize(async () => work(await this.machine()));
    return this.run({ kind: "waking" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      return work(machine);
    });
  }

  /**
   * While the brain and this Mac are both awake, its copies follow this Mac's branches: each project switched on whose
   * branch moved since the brain took it is sent. Light: the branches are read here first, and the brain is asked only
   * when one moved. Never wakes the brain; one asleep meanwhile is refreshed at its next wake.
   */
  async freshenProjects(): Promise<void> {
    const stored = await this.record.read().catch(() => null);
    if (!stored?.ready || !stored.projects?.length || this.sendingProject) return;
    if (!(await anyMoved(this.deps.db, stored.projects, this.stuck))) return;
    await this.serialize(() => this.refreshProjects()).catch(() => undefined);
    this.stuck = await failedAt(this.deps.db, (await this.record.read().catch(() => null))?.projects ?? []);
  }

  /** The brain counts its conversations again when it runs, for the Remove confirm. Never wakes it. */
  async recount(): Promise<void> {
    await this.serialize(() => this.refreshProjects(false)).catch(() => undefined);
  }

  /** What the brain and its thread sandboxes ran and kept this month, at Vercel's list prices; null before setup. Never wakes it. */
  async cost(now = Date.now()): Promise<CloudBrainCost | null> {
    const stored = await this.record.read().catch(() => null);
    if (!stored?.ready) return null;
    return this.costs.read(now, async (since) => {
      const machine = await this.reach(stored).then((access) => this.open(access, false));
      return machine?.costSince ? machine.costSince(since) : null;
    });
  }

  /** The brain's link key, as the brain itself said it, which this Mac dials it with. */
  async rememberLinkKey(linkKey: string): Promise<void> {
    await this.serialize(async () => {
      const stored = await this.stored();
      if (stored.linkKey !== linkKey) await this.record.write({ ...stored, linkKey });
    });
  }

  /** The brain's machine no longer exists on its team, and its ledger is gone with it. */
  async machineGone(): Promise<boolean> {
    const stored = await this.record.read();
    if (!stored) return true;
    const machine = await this.open(await this.reach(stored), false);
    return !machine || (await machine.status()).state === "missing";
  }

  /** This Mac's projects, Workspace aside, and which the brain has a copy of. Never wakes the brain. */
  async projects(): Promise<CloudBrainProject[]> {
    return projectsShown(this.deps.db, (await this.record.read().catch(() => null))?.projects ?? [], this.sendingProject);
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
        await this.record.write({ ...stored, projects: [...(stored.projects ?? []), switchedOn(id, copy.branch)] });
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
      await this.record.write({ ...now, projects: now.projects?.filter((project) => project.id !== id) });
    }).catch(() => undefined);
  }

  /**
   * Makes the brain on the service new cloud machines run on, on Vercel in the region, and sets it up in the
   * background, its progress in the status. Again after a failure, or on a brain that is set up, it keeps the key and
   * place it has and installs this build's brain, unless the machine has a newer one.
   */
  async create(region?: BrainRegion): Promise<void> {
    const source = await this.serialize(() => this.prepare(region)).catch(async (error: unknown) => {
      throw new Error(await this.scrub(error));
    });
    if (source) void this.run({ kind: "setting-up", step: "machine" }, () => this.setUp(source)).catch(() => undefined);
  }

  /** Starts the brain unless it runs, and sends sign-ins that changed. A failure shows in the status. */
  async wake(): Promise<void> {
    await this.run({ kind: "waking" }, async () => this.wakeUp(await this.machine())).catch(() => undefined);
  }

  /** Wakes the brain and asks it for a phone pairing code. A failure shows in the status too, since it can end setup. */
  pair(): Promise<CloudBrainPairing> {
    return this.run({ kind: "waking" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      const { url, expiresAt } = await machine.control({ op: "pair" });
      this.phones.pairing(expiresAt);
      return { url, expiresAt };
    });
  }

  /** Sends the sign-ins, waking the brain. A failure shows in the status. */
  async handover(): Promise<void> {
    await this.run({ kind: "sending" }, async () => this.wakeUp(await this.machine(), true)).catch(() => undefined);
  }

  /** What the brain signs in with besides Claude. Never wakes the brain. */
  async signIns(): Promise<CloudBrainSignIns> {
    const record: SignInRecord = (await this.record.read().catch(() => null)) ?? {};
    return signInsView(this.codexWaiting === undefined ? record : { ...record, codexNext: this.codexWaiting }, this.sources());
  }

  /** Opens the browser to sign in to Codex for the brain alone. The login goes to the brain, woken for it, and this Mac keeps none once it took it. */
  codexSignIn(): void {
    this.sources().codex.start(async (login) => this.codexNext({ id: randomUUID(), mode: "chatgpt", ...login }));
  }

  codexCancel(): void {
    this.sources().codex.cancel();
  }

  /** Once the browser sign-in for the brain's Codex ended, its login on its way to the brain or not. */
  codexFinished(): Promise<void> {
    return this.sources().codex.finished();
  }

  /** An OpenAI API key for the brain's Codex, in place of a ChatGPT sign-in. */
  codexApiKey(key: string): void {
    this.codexNext({ id: randomUUID(), mode: "apiKey", auth: apiKeyAuth(key), email: null, plan: null });
  }

  /** Signs the brain out of Codex. */
  codexRemove(): void {
    this.codexNext(null);
  }

  /**
   * Switched on, the brain gets this Mac's GitHub sign-in, and again whenever this Mac's changes; switched off, the
   * brain deletes its copy. Wakes the brain for it; a failure shows in the status.
   */
  async setGitHub(on: boolean): Promise<void> {
    await this.run({ kind: "sending" }, async () => {
      const mac = on ? await this.sources().github(true) : null;
      if (mac && "blocked" in mac) throw new Error(mac.blocked);
      await this.record.write(switchGitHub(await this.stored(), on));
      if (await this.behind()) await this.wakeUp(await this.machine());
    }).catch(() => undefined);
  }

  /**
   * Kept in the record until the brain takes it, so a brain that could not be reached gets it at its next wake. Shown as
   * waiting at once, while it waits its turn behind whatever runs; a failure shows in the status.
   */
  private codexNext(login: HandoverCodexLogin | null): void {
    this.codexWaiting = login;
    this.changed();
    const kept = this.serialize(async () => {
      const stored = await this.stored();
      if (login === null && !stored.codex && stored.codexNext === undefined) return false;
      await this.record.write({ ...stored, codexNext: login });
      return true;
    });
    void kept
      .then(async (wrote) => {
        if (wrote) await this.handover();
      })
      .catch(async (error: unknown) => {
        this.error = await this.scrub(error);
      })
      .finally(() => {
        this.codexWaiting = undefined;
        this.changed();
      });
  }

  /** A sign-in changed on this Mac, a Claude cloud token or the push key: a brain that is set up takes it, woken for it. */
  signInsChanged(): void {
    void this.serialize(async () => {
      if (!(await this.record.read())?.ready || !(await this.behind())) return;
      await this.tracked({ kind: "sending" }, async () => this.wakeUp(await this.machine()));
    }).catch(() => undefined);
  }

  /** Once this Mac's core has started: the door is brought to this build, as after an update. Wakes nothing. */
  opened(): void {
    this.refreshDoor();
  }

  /**
   * A connection, a size or "Run on" changed: a running brain takes where its new threads run at once, an asleep one at
   * its next wake, so this never wakes it. A Vercel brain's door takes the token and size, since it wakes the brain with them.
   */
  cloudChanged(): void {
    this.refreshDoor();
    void this.serialize(async () => {
      const stored = await this.record.read();
      if (!stored?.ready || !(await this.behind())) return;
      await this.send(await this.machine()).catch((error: unknown) => {
        if (!(error instanceof BrainUnavailable)) throw error;
      });
    }).catch(async (error: unknown) => {
      this.error = await this.scrub(error);
      this.changed();
    });
  }

  /**
   * Forgets the Vercel connection with `forget`, once a Vercel brain's door's deployments and its copy of the token are
   * gone. One step, so no queued look opens the door again in between. Throws when they could not go, and the
   * connection stays.
   */
  disconnect(forget: () => Promise<unknown>): Promise<void> {
    return this.serialize(async () => {
      const stored = await this.record.read();
      const vercel = await this.deps.vercel();
      if (stored && stored.service !== "agent37" && vercel) await this.door.close({ token: vercel.token, teamId: stored.teamId });
      await forget();
    });
  }

  /**
   * Deletes a Vercel brain's door, then the brain, its disk and its thread machines, then forgets its key. A brain
   * found elsewhere goes from where Settings points. A failure shows in the status.
   */
  async remove(): Promise<void> {
    await this.run({ kind: "removing" }, async () => {
      const stored = await this.record.read();
      const access = stored ? await this.reach(stored) : await accessHere(this.connections);
      if (!access) throw new Error("Connect Vercel or Agent37 first.");
      // First, so nothing wakes the brain while it goes.
      if (access.service === "vercel") await this.door.remove({ token: access.token, teamId: access.teamId });
      await (await this.open(access, false))?.remove();
      await this.record.write(null);
      this.phones.forget();
      this.elsewhere = null;
    }).catch(() => undefined);
  }

  /** The checks a Set up click hears at once. Null when there is nothing to set up in the background. */
  private async prepare(region: BrainRegion | undefined) {
    if (this.activity?.kind === "setting-up") return null;
    const source = await this.deps.bundle?.();
    if (!source) throw new Error(unavailable);
    const stored = await this.record.read();
    if (stored) await this.reach(stored);
    else {
      const access = await accessHere(this.connections);
      if (!access) throw new Error("Connect Vercel or Agent37 first.");
      const place = placeOf(access, region);
      const machine = await this.open(access, false);
      if (machine && (await machine.status()).state !== "missing") {
        this.elsewhere = { service: serviceOf(place), account: accountOf(access) };
        this.changed();
        return null;
      }
      // Saved before anything is made, so whatever setup leaves behind opens with a key this Mac keeps.
      await this.record.write({ key: brainKeyText(newBrainKey()), ...place, address: null, ready: false, claude: [] });
    }
    this.elsewhere = null;
    this.activity = { kind: "setting-up", step: "machine" };
    this.changed();
    return source;
  }

  private async setUp(source: BrainBundleSource): Promise<void> {
    const machine = await this.machine(true);
    const { installed } = await machine.provision({ version: source.version, archive: await source.read() }, provisionAt(await this.stored()));
    await this.record.write({ ...(await this.stored()), version: installed });
    this.step("start");
    await this.startInstalled(machine);
    await this.alignAgents(machine).catch(() => undefined);
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
   * Then hands over what changed since it last took it, or everything with `sendAll`.
   */
  private async wakeUp(machine: BrainMachineLike, sendAll = false): Promise<void> {
    await this.update(machine).catch(async (error: unknown) => {
      this.error = `The cloud brain could not be updated. ${await this.scrub(error)}`;
    });
    await this.startInstalled(machine);
    // One that failed is asked again at the next wake; a move meanwhile refuses in words if the versions differ.
    await this.alignAgents(machine).catch(() => undefined);
    this.refreshAfter();
    // Before whoever woke it asks anything: a thread it starts next runs where "Run on" says now.
    if (sendAll || (await this.behind())) await this.send(machine);
  }

  /**
   * Before anything else in a wake, as a move's: the brain's agent CLIs at this Mac's versions, so a conversation moved
   * either way resumes. Asked only when they changed since the brain last said it had them; never of an older brain.
   */
  private async alignAgents(machine: BrainMachineLike): Promise<void> {
    const stored = await this.stored();
    if (!this.deps.agentVersions || (await this.behindUpdate(stored))) return;
    const confirmed = await alignAgentVersions(machine, stored.agentVersions, await this.deps.agentVersions());
    if (confirmed) await this.record.write({ ...(await this.stored()), agentVersions: confirmed });
  }

  /** Once the operation that woke the brain ends, so the brain runs this build's version first and a pairing waits on nothing. */
  private refreshAfter(): void {
    void this.serialize(() => this.refreshSignIns()).catch(() => undefined);
    void this.serialize(() => this.refreshProjects()).catch(() => undefined);
    this.refreshDoor();
  }

  /** Queued behind what runs. Never wakes the brain; costs one look at the door when it is current. */
  private refreshDoor(): void {
    void this.serialize(async () => {
      const door = (await this.deps.bundle?.())?.door;
      if (!door) return;
      const stored = await this.record.read();
      const vercel = await this.deps.vercel();
      // An Agent37 brain needs no door: any request to its address wakes it.
      if (!stored?.ready || stored.service === "agent37" || !vercel) return;
      const access = { token: vercel.token, teamId: stored.teamId };
      const project = this.deps.projects?.brain ?? BRAIN_PROJECT;
      await this.door.open(access, { ...(await this.wakeInput(stored)), vercel: { ...access, project }, revoked: this.phones.refused() }, door);
    }).catch(() => undefined);
  }

  /** What a wake hands the brain, the same for this Mac's own wake and its door's. */
  private async wakeInput(stored: StoredBrain): Promise<WakeInput> {
    return { key: brainKeyFrom(stored.key), name: BRAIN_NAME, ...(await threadSizes(stored, this.connections)) };
  }

  /**
   * Hears which copies the brain has, then, unless only counting, sends each project switched on whose branch moved since
   * the brain's copy took it, one at a time. Never wakes the brain: one that went to sleep meanwhile is refreshed at its
   * next wake.
   */
  private async refreshProjects(send = true): Promise<void> {
    const stored = await this.record.read();
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
    await confirmCurrent(machine, this.deps.db, records);
    if (!send) return;
    for (const record of records) {
      const project = projects.get(this.deps.db, record.id);
      if (!project || !(await stale(project, record))) continue;
      const next = await this.sending(project, () => freshCopy(machine, project, record)).catch(async (error: unknown) =>
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
  private async behindUpdate(stored: StoredBrain): Promise<boolean> {
    const running = this.running;
    if (!running) return false;
    const versions = [stored.version, (await this.deps.bundle?.())?.version];
    return versions.some((version) => version !== undefined && brainVersionNewer(version, running));
  }

  /** Each record replaces the one with its id, unless switched off meanwhile. */
  private async saveProjects(records: BrainProject[]): Promise<void> {
    const stored = await this.stored();
    await this.record.write({ ...stored, projects: stored.projects?.map((each) => records.find((record) => record.id === each.id) ?? each) });
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
      if (restarted !== installed) await this.record.write({ ...(await this.stored()), version: restarted });
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
      const { installed } = await machine.provision({ version: source.version, archive: await source.read() }, provisionAt(stored));
      await this.record.write({ ...(await this.stored()), version: installed });
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
        if (!stored.ready || stored.address !== result.address) await this.record.write({ ...stored, ready: true, address: result.address });
        this.running = result.version;
        return result.version;
      case "needs-provision":
        await this.record.write({ ...stored, ready: false });
        throw new Error(`The cloud brain needs setting up again. ${result.detail}`);
      case "wrong-key":
        throw new Error("This Mac's key does not open the cloud brain. Remove it to set up a new one.");
      case "failed":
        throw new Error(`The cloud brain did not start. ${result.detail}`);
    }
  }

  /**
   * Hands over every Claude account with a cloud token, so the brain drops any other, and each other sign-in that
   * changed since the brain took it. Codex goes only as a login made for the brain: a ChatGPT login's refresh token
   * works once, so this Mac's own cloud login and a copy on the brain would sign each other out. A brain running an
   * older version than this build may refuse the other kinds, and with them the whole handover, so it gets Claude's alone.
   */
  private async send(machine: BrainMachineLike): Promise<void> {
    const stored = await this.stored();
    const accounts = await this.claude();
    const handed: HandoverClaudeAccount[] = accounts.map(({ id, name, default: isDefault, token }) => ({ id, name, default: isDefault, token }));
    const others = (await this.behindUpdate(stored)) ? null : await signInChanges(stored, this.sources(stored));
    await machine.control(sealHandover(brainKeyFrom(stored.key), { claude: { accounts: handed }, ...others?.handover }));
    const now = { ...(await this.stored()), claude: accounts.map(sent) };
    await this.record.write(others ? others.took(now) : now);
  }

  /**
   * Hears which sign-ins the brain holds, then sends what it lacks: its word wins over the record, as after its disk went
   * back to an empty snapshot. Never wakes the brain, nor asks one older than this build; asks nothing while the record
   * names none.
   */
  private async refreshSignIns(): Promise<void> {
    const stored = await this.record.read();
    if (!stored?.ready || !claimsSignIns(stored) || (await this.behindUpdate(stored))) return;
    const machine = await this.machine();
    const holds = await machine.control({ op: "sign-ins" }).catch(() => null);
    if (!holds) return;
    await this.record.write(heardSignIns(await this.stored(), holds));
    this.changed();
    if (await this.behind()) await this.tracked({ kind: "sending" }, () => this.send(machine));
  }

  private async behind(): Promise<boolean> {
    const stored = await this.record.read();
    if (!stored) return false;
    if (!sameSent((await this.claude()).map(sent), stored.claude)) return true;
    return Object.keys((await signInChanges(stored, this.sources(stored))).handover).length > 0;
  }

  /** This Mac's sign-ins, with where the threads of the brain set up as `stored` run. */
  private sources(stored?: StoredBrain): SignInSources & { cloud?: CloudSource } {
    const sources = this.deps.signIns ?? NO_SIGN_INS;
    return stored ? { ...sources, cloud: () => threadCloud(stored, this.connections) } : sources;
  }

  private claude(): Promise<(Sent & { token: string })[]> {
    return claudeToSend(this.deps.db, this.deps.tokens);
  }

  /** How its service reports the brain's machine; null with a reason when it cannot be asked. */
  private async look(stored: StoredBrain): Promise<{ machine: CloudBrainMachine | "missing" | null; error: string | null }> {
    try {
      const machine = await this.open(await this.reach(stored), false);
      return { machine: machine ? shownMachine[(await machine.status()).state] : "missing", error: null };
    } catch (error) {
      return { machine: null, error: `Could not ask ${SERVICE_NAMES[serviceOf(stored)]} about the cloud brain. ${await this.scrub(error)}` };
    }
  }

  private reach(stored: StoredBrain): Promise<BrainAccess> {
    return reach(stored, this.connections);
  }

  /**
   * The machine of the brain this Mac set up, where it was made. Only setup makes a Vercel brain's project: a brain
   * whose project is gone needs setting up again.
   */
  private async machine(create = false): Promise<BrainMachineLike> {
    const stored = await this.stored();
    const machine = await this.open(await this.reach(stored), create);
    if (machine) return machine;
    await this.record.write({ ...stored, ready: false });
    throw new Error("The cloud brain's machine is gone.");
  }

  /** One connection per account and credential, since connecting to Vercel looks up the brain's project. */
  private async open(access: BrainAccess, create: boolean): Promise<BrainMachineLike | null> {
    const key = JSON.stringify(access);
    if (this.connected?.key === key) return this.connected.machine;
    const project = this.deps.projects?.brain;
    const machine = await (this.deps.open ?? openMachine)(access.service === "vercel" && project ? { ...access, project } : access, create);
    if (machine) this.connected = { key, machine };
    return machine;
  }

  /** The service of the brain found when setting up, while it is still there, where Settings points now. */
  private async stillElsewhere(): Promise<CloudService | null> {
    if (!this.elsewhere) return null;
    try {
      const access = await accessHere(this.connections);
      const machine = access && accountOf(access) === this.elsewhere.account ? await this.open(access, false) : null;
      if (!machine || (await machine.status()).state === "missing") this.elsewhere = null;
    } catch {
      // Its service could not be asked: what was found stays until it can.
    }
    return this.elsewhere?.service ?? null;
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

  /** An error's words without the Vercel token, the Agent37 key or the brain key, whatever passed them on. */
  private async scrub(error: unknown): Promise<string> {
    const secrets = [(await this.deps.vercel().catch(() => null))?.token, (await this.connections.agent37().catch(() => null))?.key, this.record.cached?.key];
    return secrets.reduce<string>((text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text), redact(words(error)).text);
  }

  private async stored(): Promise<StoredBrain> {
    const stored = await this.record.read();
    if (!stored) throw new Error("The cloud brain is not set up.");
    return stored;
  }
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
