import { createHash } from "node:crypto";
import { brainKeyText, type BrainKey } from "@openorc/cloud";
import { redact, relocations, settings, threads, type Db } from "@openorc/db";
import { isSubagentThread, type BrainRegion, type CloudBrainStatus, type CloudService, type ThreadSummary } from "@openorc/protocol";
import type { CloudBrain } from "./cloud-brain.js";
import { SERVICE_NAMES, accessHere, regionOf, serviceOf, type BrainConnections } from "./cloud-brain-place.js";
import { switchedOn, type BrainProject } from "./cloud-brain-projects.js";
import type { BrainMoving, StoredBrain } from "./cloud-brain-record.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";
import type { RelocationCoordinator } from "./relocation-coordinator.js";
import { ownRefusal } from "./relocation-rules.js";

/** What the move reads of a thread on the brain: enough to say why one can never leave it. */
export type BrainThread = Pick<ThreadSummary, "id" | "title" | "activity" | "parentRelation" | "projectId" | "agent" | "orclingId" | "worktreePath" | "branch">;

export interface BrainMoveDeps {
  db: Db;
  /** The brain this Mac keeps. */
  brain: CloudBrain;
  /** A brain kept in `store`, beside the one this Mac keeps and with phones of its own: the new one, or the old one going. */
  beside(store: ProtectedSecretStore, changed?: () => void): CloudBrain;
  /** Where the new brain's record is kept until the swap. */
  store: ProtectedSecretStore;
  connections: BrainConnections;
  /** Every thread the brain holds, archived ones too, as its own list has them, woken to say. */
  threads(): Promise<BrainThread[]>;
  coordinator: Pick<RelocationCoordinator, "bringHome" | "sendBack" | "quiet">;
  /** The records were swapped: what this Mac kept of the old brain goes, phones forget it by `linkKey`, and the link dials the new one. */
  swapped(linkKey: string | null): Promise<void>;
  changed(): void;
}

type Shown = Omit<Extract<CloudBrainStatus, { state: "moving" }>, "state">;

const STEPS: Record<BrainMoving["stage"], Shown["step"]> = { home: "home", staging: "setting-up", swapping: "removing", back: "back" };

/** Why setting up, removing, or a new cloud thread waits while the brain moves. */
export const MOVING_WORDS = "The cloud brain is moving. Try again once it's done.";
const AT_WORK = "A thread is still working on the cloud brain. Try again once it's done.";
/** How long the old brain starts no new conversation for, asked again at each look at its threads. */
const LEAVING_MS = 30 * 60_000;
/** The setting naming the brain phones pair with again, by its key's digest, until one has. */
const PAIR_AGAIN = "cloud.brain.pair-again";
/** The setting keeping what the last move left to say, until the next one or until dismissed. */
const NOTE = "cloud.brain.move-note";
/** The new and old brains keep their phones apart from the one this Mac keeps. */
export const MOVE_PHONES = "cloud.brain.move-phones";

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
const digest = (key: BrainKey) => createHash("sha256").update(brainKeyText(key)).digest("hex");
const placeIn = (stored: StoredBrain) => ({ service: serviceOf(stored), region: regionOf(stored) });
const other = (service: CloudService): CloudService => (service === "vercel" ? "agent37" : "vercel");

/** A record held in memory, for the old brain while it is removed. */
function held(value: StoredBrain): ProtectedSecretStore {
  let saved = JSON.stringify(value);
  return { load: async () => saved, save: async (next) => void (saved = next) };
}

/**
 * What a new brain starts with of the one it replaces: the projects switched on, sent whole, and the GitHub switch. Its
 * Codex login stays behind: a ChatGPT login is the old brain's alone.
 */
function kept(old: StoredBrain): Pick<StoredBrain, "projects" | "github"> {
  return { projects: (old.projects ?? []).map((project) => switchedOn(project.id, project.branch)), ...(old.github?.on ? { github: { on: true, sent: null } } : {}) };
}

function settledRecord(stored: StoredBrain): StoredBrain {
  const copy = { ...stored };
  delete copy.moving;
  return copy;
}

/** Why a thread on the brain can never come to this Mac: its own row says so, or its project has no copy here. */
function neverHome(thread: BrainThread, copies: readonly BrainProject[]): string | null {
  return ownRefusal(thread) ?? (copies.some((copy) => copy.brainId === thread.projectId) ? null : "This conversation's project has no copy on the Mac.");
}

/** Why a new brain did not get ready, said of the new brain, so nothing reads as advice about the one that stays. */
function notReady(status: CloudBrainStatus, to: CloudService): string {
  if (status.state === "elsewhere") return `${to === "vercel" ? "Your Vercel team" : "Your Agent37 account"} already has a cloud brain this Mac has no key for.`;
  if (status.state === "unavailable") return "The cloud brain isn't available in this build.";
  return `The new brain on ${SERVICE_NAMES[to]} didn't set up. ${("error" in status && status.error) || ""}`.trim();
}

/** What became of the threads that came here, said after a move that stopped before the new brain took over. */
function homeWords(count: number): string {
  if (!count) return "";
  return count === 1 ? " The conversation brought here stays on this Mac." : ` The ${count} conversations brought here stay on this Mac.`;
}

function stayedWords(stayed: { title: string; why: string }[]): string {
  const [first] = stayed;
  if (!first) return "";
  const who = stayed.length === 1 ? `“${first.title}”` : `“${first.title}” and ${stayed.length - 1} more`;
  return `${who} stayed on this Mac. ${first.why}`;
}

/**
 * Moving the cloud brain to the other service, its progress kept in the brain's record so a restart goes on from it.
 * The old brain starts no new conversation and its threads come to this Mac; a new brain is set up beside it with a key
 * of its own, and gets the sign-ins and project copies as it sets up; the old one is removed, door first, and one write
 * makes the new one the brain, both in one turn of the brain's operations; then the threads go to it. Before the swap a
 * failure leaves the old brain as it was; from removing on, a failure stops where it is, to go on or be called off.
 */
export class BrainMove {
  private shown: Shown | null = null;
  private running: Promise<void> | null = null;
  private closing = false;
  /** While the new brain sets up, its parts are followed until its own steps are done. */
  private following = false;

  constructor(private readonly deps: BrainMoveDeps) {}

  /** A move is under way or stopped, by what it shows or, before it shows anything at start, by the record. */
  async busy(): Promise<boolean> {
    return this.shown !== null || Boolean((await this.deps.brain.moves())?.moving);
  }

  /** The brain that is leaving is still the one new threads would go to: until the new one takes over. */
  async holding(): Promise<boolean> {
    if (this.shown) return this.shown.step !== "back";
    const moving = (await this.deps.brain.moves())?.moving;
    return Boolean(moving && moving.stage !== "back");
  }

  /** The move's step while one is under way; otherwise the brain's own status, with what the last move left to say. */
  async status(): Promise<CloudBrainStatus> {
    if (this.shown) return { state: "moving", ...this.shown };
    const status = await this.deps.brain.status();
    if (status.state !== "ready") return status;
    const moving = (await this.deps.brain.moves())?.moving;
    if (moving) return { state: "moving", service: status.service, region: status.region, to: moving.to, step: STEPS[moving.stage], threads: null, setup: null, error: null };
    const note = settings.get(this.deps.db, NOTE);
    return { ...status, ...((await this.pairAgain()) ? { pairAgain: true } : {}), ...(note ? { note } : {}) };
  }

  /**
   * Starts moving the ready brain to `to`, in Vercel's `region`, or goes on with a move that stopped. Throws only what is
   * known at once; the rest shows in the status.
   */
  async start(to: CloudService, region: BrainRegion | undefined): Promise<void> {
    if (this.running) return;
    const stored = await this.read();
    let moving = stored?.moving;
    if (!stored || !moving) {
      if (!stored?.ready) throw new Error("Set up the cloud brain first.");
      if (serviceOf(stored) === to) throw new Error(`The cloud brain runs on ${SERVICE_NAMES[to]} already.`);
      if (to === "vercel" && !region) throw new Error("Choose a region for the cloud brain.");
      if (!(await accessHere(this.deps.connections, to))) throw new Error(`Connect ${SERVICE_NAMES[to]} first.`);
      if (relocations.unsettled(this.deps.db).length) throw new Error("A conversation is still moving. Try again once it's done.");
      const started: BrainMoving = { to: { service: to, region: to === "vercel" ? (region ?? null) : null }, stage: "home", threads: [] };
      await this.edit((now) => ({ ...now, moving: started }));
      moving = started;
    }
    this.dismiss();
    // Shown at once, so the answer to a Move click is the move.
    this.base(stored, moving);
    this.go();
  }

  /**
   * Calls off a move that stopped. Until the old brain is gone, the new one goes and the old one stays as it was;
   * after the swap, the threads not yet back stay on this Mac.
   */
  async cancel(): Promise<void> {
    if (this.running || !this.shown?.error) throw new Error("The move is under way. Wait until it stops.");
    const moving = (await this.read())?.moving;
    if (!moving) return this.show(null);
    if (moving.stage !== "back") {
      if (moving.stage === "swapping" && (await this.deps.brain.machineGone().catch(() => false)))
        throw new Error(`The brain on ${SERVICE_NAMES[other(moving.to.service)]} is gone already. Try again to finish the move.`);
      await this.removeStaged(this.deps.beside(this.deps.store));
      await this.leave(null).catch(() => undefined);
    }
    await this.edit(settledRecord);
    this.show(null);
    // A door the stopped removal took opens again.
    this.deps.brain.opened();
  }

  /** Forgets what the last move left to say. */
  dismiss(): void {
    if (!settings.get(this.deps.db, NOTE)) return;
    settings.remove(this.deps.db, NOTE);
    this.deps.changed();
  }

  /** At start: a move this Mac quit during goes on from its stage. */
  resume(): void {
    this.go();
  }

  /** This Mac is closing: a move under way stops where it is, and goes on at the next start. */
  close(): void {
    this.closing = true;
  }

  private go(): void {
    this.running ??= this.run().finally(() => (this.running = null));
  }

  private async run(): Promise<void> {
    for (;;) {
      const stored = await this.read().catch(() => null);
      const moving = stored?.moving;
      if (!stored || !moving || this.closing) return this.show(null);
      this.base(stored, moving);
      try {
        await this.next(stored, moving);
      } catch (error) {
        if (this.closing) return this.show(null);
        if (!(await this.failed(moving, words(error)))) return;
      }
    }
  }

  private next(stored: StoredBrain, moving: BrainMoving): Promise<void> {
    switch (moving.stage) {
      case "home":
        return this.home();
      case "staging":
        return this.staging(stored, moving);
      case "swapping":
        return this.swapping();
      case "back":
        return this.back(moving);
    }
  }

  /** Each thread on the old brain comes to this Mac, as it lists them now. */
  private async home(): Promise<void> {
    this.show({ step: "home", setup: null, threads: { done: 0, of: 0 } });
    await this.bringAll(true);
    await this.stage("staging");
  }

  /**
   * The new brain is set up beside the old one, its sign-ins and project copies with it. A thread started on the old
   * brain meanwhile comes here too.
   */
  private async staging(old: StoredBrain, moving: BrainMoving): Promise<void> {
    const staged = this.deps.beside(this.deps.store, () => void this.follow(staged));
    if (!moving.staging) {
      const leftover = await staged.inTurn((record) => record.read());
      // Left by an earlier move that could not remove it. One on the other service, or never ready, may name a brain its
      // key does not open now: only its record goes, and setting up looks for a brain this Mac has no key for as always.
      if (leftover && (serviceOf(leftover) !== moving.to.service || !leftover.ready)) await staged.inTurn((record) => record.write(null));
      await this.edit((now) => ({ ...now, moving: now.moving && { ...now.moving, staging: true } }));
    }
    this.show({ step: "setting-up", setup: "machine", threads: null });
    this.following = true;
    try {
      await staged.create(moving.to.region ?? undefined, moving.to.service, kept(old));
      // A turn after its setup, then one after the sign-ins and project copies its setup queued as it ended.
      await staged.inTurn(async () => undefined);
      await staged.inTurn(async () => undefined);
    } finally {
      this.following = false;
    }
    const status = await staged.status();
    if (status.state !== "ready") throw new Error(notReady(status, moving.to.service));
    await this.bringAll(false);
    await this.stage("swapping");
  }

  /**
   * Moves under way settle and the old brain is asked once more for its threads, as this Mac may have been off while its
   * phones kept on. Then, in one turn of the brain's operations, the old brain is removed, door first, and one write makes
   * the new one the brain: nothing wakes or redeploys the old one in between.
   */
  private async swapping(): Promise<void> {
    this.show({ step: "removing", setup: null, threads: null });
    await this.deps.coordinator.quiet();
    if (!(await this.deps.brain.machineGone())) await this.bringAll(false);
    this.show({ step: "removing", setup: null, threads: null });
    const next = await this.deps.beside(this.deps.store).inTurn((record) => record.read());
    if (!next?.ready) throw new Error("The new cloud brain's record is gone.");
    const phones = this.deps.brain.phones.list().length > 0;
    await this.deps.brain.inTurn(async (record) => {
      const old = await record.read();
      if (!old?.moving) throw new Error("The move's record is gone.");
      const retiring = this.deps.beside(held(settledRecord(old)));
      await retiring.remove();
      if (await retiring.inTurn((left) => left.read())) {
        const after = await retiring.status();
        throw new Error(("error" in after && after.error) || `The cloud brain on ${SERVICE_NAMES[serviceOf(old)]} could not be removed.`);
      }
      await record.write({ ...next, moving: { ...old.moving, stage: "back", left: { linkKey: old.linkKey ?? null, phones } } });
    });
    this.deps.changed();
  }

  /**
   * Once the swap is written: the old brain's phones go, the new one's record leaves the store it was set up in, and
   * this Mac lets the old one go. Again after a restart, until it is done.
   */
  private async letGo(left: NonNullable<BrainMoving["left"]>): Promise<void> {
    this.deps.brain.phones.forget();
    const key = (await this.deps.brain.moves())?.key;
    if (left.phones && key) settings.set(this.deps.db, PAIR_AGAIN, digest(key));
    if (await this.deps.store.load()) await this.deps.store.save("");
    await this.deps.swapped(left.linkKey);
    // On Vercel, its door opens now rather than at its first wake.
    this.deps.brain.opened();
    await this.edit((now) => {
      const next = now.moving && { ...now.moving };
      delete next?.left;
      return { ...now, moving: next };
    });
  }

  /** Each thread that came here goes to the new brain; one that cannot stays here, and the move ends all the same. */
  private async back(moving: BrainMoving): Promise<void> {
    if (moving.left) await this.letGo(moving.left);
    const of = moving.threads.length;
    this.show({ step: "back", setup: null, threads: { done: 0, of } });
    const stayed: { title: string; why: string }[] = [];
    for (const [index, id] of moving.threads.entries()) {
      const title = threads.get(this.deps.db, id)?.title ?? "A conversation";
      const why = await this.deps.coordinator.sendBack(id);
      if (why) stayed.push({ title, why });
      this.show({ threads: { done: index + 1, of } });
    }
    await this.edit(settledRecord);
    this.show(null);
    if (stayed.length) await this.note(stayedWords(stayed));
  }

  /**
   * Brings every thread the old brain lists here, one at a time, once it starts no new one. One that can never leave it,
   * or one at work, refuses before any moves; the first that stays stops the move. Shown as the step's progress when
   * `shown`, else only when there is something to bring.
   */
  private async bringAll(shown: boolean): Promise<void> {
    await this.leave(Date.now() + LEAVING_MS);
    const listed = (await this.deps.threads()).filter((thread) => !isSubagentThread(thread));
    const copies = (await this.deps.brain.moves())?.projects ?? [];
    const stuck = listed.map((thread) => ({ thread, why: neverHome(thread, copies) })).find(({ why }) => why);
    if (stuck) throw new Error(`“${stuck.thread.title}” can't leave the cloud brain. ${stuck.why}`);
    if (listed.some((thread) => thread.activity !== "idle")) throw new Error(AT_WORK);
    if (!listed.length && !shown) return;
    const kept = (await this.read())?.moving?.threads ?? [];
    let done = kept.filter((id) => !listed.some((thread) => thread.id === id)).length;
    const of = done + listed.length;
    this.show({ step: "home", setup: null, threads: { done, of } });
    for (const thread of listed) {
      // Kept before it moves, so a restart sends it back whatever point it stopped at.
      if (!kept.includes(thread.id)) await this.edit((now) => ({ ...now, moving: now.moving && { ...now.moving, threads: [...now.moving.threads, thread.id] } }));
      const stayed = await this.deps.coordinator.bringHome(thread.id);
      if (stayed !== null) throw new Error(`“${thread.title}” stayed on the cloud brain. ${stayed}`);
      this.show({ threads: { done: ++done, of } });
    }
  }

  /**
   * Before removing, the old brain stays as it was: a new one set up is removed, it starts conversations again, and the
   * move ends with why. From removing on, or when the move's record cannot be cleared, the move stops where it is, to go
   * on or be called off. False then.
   */
  private async failed(moving: BrainMoving, why: string): Promise<boolean> {
    if (moving.stage === "swapping" || moving.stage === "back") return this.stopped(why);
    let error = why;
    if (moving.stage === "staging")
      error = await this.removeStaged(this.deps.beside(this.deps.store)).then(
        () => why,
        (left: unknown) => `${why} ${words(left)}`,
      );
    await this.leave(null).catch(() => undefined);
    const brought = (await this.read().catch(() => null))?.moving?.threads ?? moving.threads;
    const home = brought.filter((id) => threads.get(this.deps.db, id)).length;
    try {
      await this.edit(settledRecord);
    } catch (clear) {
      return this.stopped(`${error} ${words(clear)}`);
    }
    this.show(null);
    await this.note(`Didn't move to ${SERVICE_NAMES[moving.to.service]}. ${error}${homeWords(home)}`);
    return true;
  }

  private async stopped(why: string): Promise<false> {
    this.show({ error: await this.scrub(why) });
    return false;
  }

  /** Removes a new brain set up beside this one, door first. Never one it has no record of, as one found elsewhere. */
  private async removeStaged(staged: CloudBrain): Promise<void> {
    const stored = await staged.inTurn((record) => record.read());
    if (!stored) return;
    await staged.remove();
    if (!(await staged.inTurn((record) => record.read()))) return;
    const after = await staged.status();
    throw new Error(`The new brain on ${SERVICE_NAMES[serviceOf(stored)]} was not removed. ${("error" in after && after.error) || ""}`.trim());
  }

  /** The old brain starts no new conversation until `until`, or again with null. Ending it never wakes the brain: one asleep lets it run out. */
  private async leave(until: number | null): Promise<void> {
    await this.deps.brain.withMachine(until !== null, (machine) => machine.control({ op: "leaving", until }));
  }

  /** The new brain's own setup steps, then its project copies once those are done. */
  private async follow(staged: CloudBrain): Promise<void> {
    if (!this.following || this.shown?.setup === "projects") return;
    const status = await staged.status();
    if (!this.following) return;
    if (status.state === "setting-up") this.show({ setup: status.step });
    else if (status.state === "ready") this.show({ setup: "projects" });
  }

  /** Phones paired before a move cannot reach the brain it moved to: Settings asks until one pairs with it. */
  private async pairAgain(): Promise<boolean> {
    const brain = settings.get(this.deps.db, PAIR_AGAIN);
    if (!brain) return false;
    const key = (await this.deps.brain.moves())?.key;
    if (key && digest(key) === brain && !this.deps.brain.phones.list().length) return true;
    settings.remove(this.deps.db, PAIR_AGAIN);
    return false;
  }

  /** What a move leaves to say, kept past the brain's next operation until the next move or until dismissed. */
  private async note(text: string): Promise<void> {
    settings.set(this.deps.db, NOTE, await this.scrub(text));
    this.deps.changed();
  }

  /** Words without the connections' token and key or either brain's key, whatever passed them on. */
  private async scrub(text: string): Promise<string> {
    const vercel = await this.deps.connections.vercel().catch(() => null);
    const agent37 = await this.deps.connections.agent37().catch(() => null);
    const brain = (await this.deps.brain.moves())?.key;
    const staged = await this.deps
      .beside(this.deps.store)
      .inTurn((record) => record.read())
      .catch(() => null);
    const secrets = [vercel?.token, agent37?.key, brain && brainKeyText(brain), staged?.key];
    return secrets.reduce<string>((said, secret) => (secret ? said.replaceAll(secret, "[redacted]") : said), redact(text).text);
  }

  private stage(stage: BrainMoving["stage"]): Promise<void> {
    return this.edit((now) => ({ ...now, moving: now.moving && { ...now.moving, stage } }));
  }

  /** The brain's record, `next` applied to it in turn with the brain's operations. */
  private async edit(next: (stored: StoredBrain) => StoredBrain): Promise<void> {
    await this.deps.brain.inTurn(async (record) => {
      const stored = await record.read();
      if (stored) await record.write(next(stored));
    });
    this.deps.changed();
  }

  private read(): Promise<StoredBrain | null> {
    return this.deps.brain.inTurn((record) => record.read());
  }

  /** What a move shows as its stage starts: where the brain runs now, where it goes, and the stage's step. */
  private base(stored: StoredBrain, moving: BrainMoving): void {
    this.shown = { ...placeIn(stored), to: moving.to, step: STEPS[moving.stage], threads: null, setup: null, error: null };
    this.deps.changed();
  }

  /** Settings hears each change: what the move shows, merged into what it showed, or nothing once it ended. */
  private show(shown: Partial<Shown> | null): void {
    if (!this.shown) return;
    this.shown = shown && { ...this.shown, ...shown };
    this.deps.changed();
  }
}
