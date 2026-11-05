import { createHash, randomUUID } from "node:crypto";
import type { BrainControlRequest, BrainControlResults } from "@openorc/cloud";
import { nextPhase, projects, relocations, settled, threads, type CoordinatorRelocation, type Db, type StepOutcome } from "@openorc/db";
import type { MoveStep, Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { closeMirror } from "./brain-mirrors.js";
import type { CloudWorkspaceService } from "./cloud-workspaces.js";
import { RelocationRefused } from "./relocation-package.js";
import { AT_WORK, relocationRefusal } from "./relocation-rules.js";
import type { ThreadRelocations } from "./relocations.js";

type Ask = Exclude<BrainControlRequest, { op: "receive-thread" }> & { op: "drop-arrival" | "hand-off-thread" | "cancel-hand-off" | "handed-off" };

/** What the coordinator needs of the cloud brain. The Mac's CloudBrain provides it. */
export interface BrainChannel {
  /** A brain is set up: moves go to it. Never wakes it. */
  ready(): Promise<boolean>;
  /** The brain's copy of a Mac project: what it holds of the branch, or why there is none. */
  copy(macProject: string): Promise<{ sent: string | null } | { missing: string }>;
  /** Wakes the brain, updating it first, then runs `work` with it. */
  awake<T>(work: (brain: AwakeBrain) => Promise<T>): Promise<T>;
  /** The brain's machine is gone, and its ledger with it. */
  gone(): Promise<boolean>;
}

export interface AwakeBrain {
  receive(relocation: string, bytes: Uint8Array): Promise<BrainControlResults["receive-thread"]>;
  ask<R extends Ask>(request: R): Promise<BrainControlResults[R["op"]]>;
  download(file: string): Promise<Uint8Array>;
}

export interface CoordinatorDeps {
  db: Db;
  brain: BrainChannel;
  relocations: ThreadRelocations;
  runs: { threadActivity(threadId: string): "idle" | "running" | "waiting"; liveRunForThread(threadId: string): { id: string } | null; closeAndWait(runId: string): Promise<void> };
  /** Moves a checkout conversation's changes to a worktree of its own, as moving it to a worktree does. */
  toWorktree(threadId: string): Promise<Thread>;
  cloud: Pick<CloudWorkspaceService, "get" | "sync">;
  changed(threadId: string): void;
  log: Logger;
  /** How long to wait before asking an unreachable brain again. */
  retryMs?: number;
  /** Called after every phase written and every brain answer; the crash matrix stops the coordinator here. */
  step?(name: string): void;
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ARRIVED: Record<CoordinatorRelocation["direction"], string> = {
  "to-mac": "This conversation is on this Mac already.",
  "to-cloud": "This conversation is in the cloud already.",
};
/** The move reached its target, so Keep comes too late. */
const arrived = (row: CoordinatorRelocation) => row.phase === "done" || (row.direction === "to-mac" && row.phase === "received");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The Mac's half: it moves threads to the cloud brain and back, since only the Mac can reach both ledgers. Each move is a
 * journal row driven phase by phase through `nextPhase`; a phase is written before the step after it starts, so a crash
 * anywhere resumes at the last phase written. Nothing unfreezes on a timer, and only an answer from the brain settles a
 * move it may have committed.
 */
export class RelocationCoordinator {
  private readonly driving = new Map<string, Promise<void>>();
  private readonly settling = new Map<string, Promise<void>>();
  /** Moves whose unanswered brain was logged already: a brain that stays down is retried quietly. */
  private readonly warned = new Set<string>();
  private closed = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  /** Move to cloud. Refuses, changing nothing, when the thread cannot move now. Returns the frozen thread. */
  async toCloud(threadId: string): Promise<Thread> {
    const { db, runs } = this.deps;
    let thread = threads.get(db, threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    const refusal = relocationRefusal(db, thread) ?? (relocations.openFor(db, threadId) ? "This conversation is already moving." : null);
    if (refusal) throw new Error(refusal);
    const copy = await this.deps.brain.copy(thread.projectId);
    if ("missing" in copy) throw new Error(copy.missing);
    if (runs.threadActivity(threadId) !== "idle") throw new Error(AT_WORK);
    const live = runs.liveRunForThread(threadId);
    if (live) await runs.closeAndWait(live.id);
    if (thread.workspaceMode === "current") thread = await this.deps.toWorktree(threadId);
    // A thread running in a sandbox from this Mac brings its last changes and session here first.
    if (this.deps.cloud.get(threadId)) await this.deps.cloud.sync(thread, { turnEnded: true });
    // The idle check and the freeze in one synchronous step, so no turn starts between them.
    if (runs.threadActivity(threadId) !== "idle") throw new Error(AT_WORK);
    const row = relocations.open(db, {
      id: randomUUID(),
      threadId,
      role: "coordinator",
      direction: "to-cloud",
      phase: "frozen",
      projectId: thread.projectId,
      step: "packing",
    }) as CoordinatorRelocation;
    this.deps.changed(threadId);
    this.step("frozen");
    this.drive(row.id);
    return threads.get(db, threadId)!;
  }

  /** Bring to Mac: asks the brain for its thread. The brain refuses, freezing nothing, when it cannot move now. */
  bringToMac(threadId: string): void {
    const { db } = this.deps;
    if (threads.get(db, threadId)) throw new Error("This conversation is on this Mac already.");
    if (relocations.openFor(db, threadId)) throw new Error("This conversation is already moving.");
    const row = relocations.open(db, { id: randomUUID(), threadId, role: "coordinator", direction: "to-mac", phase: "asking", projectId: null, step: "waking" });
    this.deps.changed(threadId);
    this.step("asking");
    this.drive(row.id);
  }

  /** "Keep where it is" while a move has not settled, when the other side can still be told. */
  async cancel(threadId: string): Promise<void> {
    const { db } = this.deps;
    const row = relocations.openFor(db, threadId);
    if (row?.role !== "coordinator") {
      const last = relocations.latest(db, threadId);
      if (last?.role === "coordinator" && arrived(last)) throw new Error(ARRIVED[last.direction]);
      return;
    }
    if (arrived(row)) throw new Error(ARRIVED[row.direction]);
    if (row.phase === "frozen") return this.finish(row.id, { kind: "kept" });
    const outcome = await this.ask(row.id, async (brain): Promise<StepOutcome> => {
      // Read again in turn with the drive: once this Mac took the thread, the brain must not unfreeze its copy.
      const now = this.row(row.id);
      if (now?.phase !== row.phase) return { kind: "unreachable" };
      if (row.direction === "to-cloud") return "received" in (await brain.ask({ op: "drop-arrival", relocation: row.id, threadId })) ? { kind: "received" } : { kind: "dropped" };
      return "left" in (await brain.ask({ op: "cancel-hand-off", relocation: row.id, threadId })) ? { kind: "left" } : { kind: "stayed" };
    });
    if (outcome.kind === "unreachable" && this.row(row.id)?.phase === row.phase) throw new Error("The cloud brain can't be reached. Try again in a moment.");
    await this.finish(row.id, outcome);
    const now = this.row(row.id);
    if (now && arrived(now)) throw new Error(ARRIVED[now.direction]);
  }

  /** The brain was removed: every move to or from it settles now, as its next try would find, rather than then. */
  async brainRemoved(): Promise<void> {
    if (!(await this.deps.brain.gone().catch(() => false))) return;
    await Promise.all(relocations.unsettled(this.deps.db).map((row) => this.finish(row.id, { kind: "gone" })));
  }

  /** A cloud brain is set up, so Move to cloud hands threads to it. Never wakes it. */
  ready(): Promise<boolean> {
    return this.deps.brain.ready();
  }

  /**
   * At start: unsettled moves go on. A brain removed since settles them as gone, so they never stay frozen; a Mac with
   * nothing pending reads nothing more.
   */
  start(): void {
    if (relocations.unsettled(this.deps.db).length > 0 || relocations.withCleanup(this.deps.db).length > 0) this.resume();
  }

  /** Drives every unsettled move, at start and whenever the brain may be reachable again. Never awaited. */
  resume(): void {
    for (const row of relocations.unsettled(this.deps.db)) this.drive(row.id);
    for (const id of relocations.withCleanup(this.deps.db))
      void this.deps.relocations.cleanUp(id).catch((error: unknown) => this.deps.log.warn(`a moved conversation's folder was not cleaned up: ${words(error)}`));
  }

  close(): void {
    this.closed = true;
  }

  /** A step hook that throws stops every move here, as a crash would. */
  private step(name: string): void {
    try {
      this.deps.step?.(name);
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }

  private drive(id: string): void {
    if (this.closed || this.driving.has(id)) return;
    const run = this.loop(id)
      .catch((error: unknown) => this.deps.log.warn(`moving a conversation stopped: ${words(error)}`))
      .finally(() => this.driving.delete(id));
    this.driving.set(id, run);
  }

  private async loop(id: string): Promise<void> {
    for (let row = this.row(id); row && !settled(row) && !this.closed; row = this.row(id)) {
      const outcome = await this.next(row);
      if (outcome.kind === "unreachable") {
        await new Promise((resolve) => setTimeout(resolve, this.deps.retryMs ?? 30_000));
        continue;
      }
      await this.finish(id, outcome);
    }
  }

  /** Where the move stands now, for its card. */
  private at(row: CoordinatorRelocation, step: MoveStep): void {
    relocations.setStep(this.deps.db, row.id, step);
    this.deps.changed(row.threadId);
  }

  private row(id: string): CoordinatorRelocation | null {
    const row = relocations.get(this.deps.db, id);
    return row?.role === "coordinator" ? row : null;
  }

  /** One attempt at the row's current phase. */
  private async next(row: CoordinatorRelocation): Promise<StepOutcome> {
    switch (row.phase) {
      case "frozen":
        return this.send(row);
      case "sending":
        return this.ask(row.id, async (brain) => this.deliver(row, brain));
      case "asking":
        // Each try wakes the brain again first, whatever step the last one stopped at.
        if (row.step !== "waking") this.at(row, "waking");
        return this.ask(row.id, async (brain) => this.fetch(row, brain));
      case "received":
        // This Mac holds the thread now, so a read-only copy of it here has nothing left to follow.
        await closeMirror(this.deps.db, row.threadId).catch((error: unknown) => this.deps.log.warn(`a moved conversation's copy was not closed: ${words(error)}`));
        return this.ask(row.id, async (brain) => {
          await brain.ask({ op: "handed-off", relocation: row.id });
          this.step("handed-off answered");
          return { kind: "left" };
        });
      default:
        return { kind: "unreachable" };
    }
  }

  /**
   * frozen: packs, wakes the brain, writes `sending`, then delivers. A thread that cannot be packed, or a brain that
   * cannot be woken, leaves the thread here, unfrozen with the reason, since nothing was sent before `sending`.
   */
  private async send(row: CoordinatorRelocation): Promise<StepOutcome> {
    let sending = false;
    try {
      const packed = await this.pack(row, await this.since(row));
      this.at(row, "waking");
      return await this.deps.brain.awake(async (brain) => {
        if (!relocations.advance(this.deps.db, row.id, "frozen", "sending")) return { kind: "unreachable" };
        sending = true;
        this.step("sending");
        return this.deliver(row, brain, packed);
      });
    } catch (error) {
      if (this.closed) throw error;
      if (!sending) return { kind: "refused", reason: words(error) };
      return (await this.deps.brain.gone().catch(() => false)) ? { kind: "gone" } : { kind: "unreachable" };
    }
  }

  /**
   * sending: the package to the brain, again whenever unsure; only the brain's answer settles it. When a package can no
   * longer be made, the brain is asked to call the move off, and says whether it took an earlier one.
   */
  private async deliver(row: CoordinatorRelocation, brain: AwakeBrain, packed?: Uint8Array): Promise<StepOutcome> {
    let first: Uint8Array;
    try {
      first = packed ?? (await this.pack(row, await this.since(row)));
    } catch (error) {
      const dropped = await brain.ask({ op: "drop-arrival", relocation: row.id, threadId: row.threadId });
      return "received" in dropped ? { kind: "received" } : { kind: "refused", reason: words(error) };
    }
    let answer = await brain.receive(row.id, first);
    if ("lacksBase" in answer) answer = await brain.receive(row.id, await this.pack(row, []));
    this.step("receive answered");
    if ("received" in answer) return { kind: "received" };
    if ("refused" in answer) return { kind: "refused", reason: answer.refused };
    return { kind: "unreachable" };
  }

  /** What the brain's copy of the project holds already, so a package leaves it out. */
  private async since(row: CoordinatorRelocation): Promise<string[]> {
    const copy = await this.deps.brain.copy(row.projectId ?? "");
    return "sent" in copy && copy.sent ? [copy.sent] : [];
  }

  private pack(row: CoordinatorRelocation, since: readonly string[]): Promise<Uint8Array> {
    return this.deps.relocations.pack(row.id, row.threadId, { from: "mac", macProject: row.projectId ?? "", since });
  }

  /** asking: the brain freezes its copy and packs it; this Mac takes it in one transaction with `received`. */
  private async fetch(row: CoordinatorRelocation, brain: AwakeBrain): Promise<StepOutcome> {
    this.at(row, "packing");
    const handed = await brain.ask({ op: "hand-off-thread", relocation: row.id, threadId: row.threadId });
    this.step("hand-off answered");
    if ("refused" in handed) return { kind: "refused", reason: handed.refused };
    this.at(row, "sending");
    const bytes = await brain.download(handed.file);
    if (bytes.length !== handed.bytes || sha256(bytes) !== handed.sha256) return { kind: "unreachable" };
    try {
      await this.deps.relocations.take(Buffer.from(bytes), {
        projectId: (macProject) => (projects.get(this.deps.db, macProject) ? macProject : null),
        place: "here",
        commit: () => {
          if (!relocations.advance(this.deps.db, row.id, "asking", "received")) throw new Error("This move was called off.");
        },
      });
      this.step("received");
      return { kind: "imported" };
    } catch (error) {
      if (!(error instanceof RelocationRefused)) throw error;
      // The brain froze its copy for this Mac, so it hears this Mac will not take it.
      await brain.ask({ op: "cancel-hand-off", relocation: row.id, threadId: row.threadId });
      return { kind: "refused", reason: error.message };
    }
  }

  /** One brain operation for move `id`, its failures sorted: a brain that is gone, or one that cannot be reached now. */
  private async ask(id: string, work: (brain: AwakeBrain) => Promise<StepOutcome>): Promise<StepOutcome> {
    try {
      return await this.deps.brain.awake(work);
    } catch (error) {
      if (this.closed) throw error;
      if (await this.deps.brain.gone().catch(() => false)) return { kind: "gone" };
      if (!this.warned.has(id)) this.deps.log.warn(`the cloud brain did not answer a move: ${words(error)}`);
      this.warned.add(id);
      return { kind: "unreachable" };
    }
  }

  /**
   * The row's next phase for `outcome`, read and written one at a time per move, so a cancel and the drive never settle
   * it twice. A move to the cloud that is done lets this Mac's copy go in the transaction that settles it.
   */
  private finish(id: string, outcome: StepOutcome): Promise<void> {
    const previous = this.settling.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const row = this.row(id);
      if (!row) return;
      const { phase, error } = nextPhase(row, outcome);
      if (phase === row.phase) return;
      if (row.direction === "to-cloud" && phase === "done")
        await this.deps.relocations.letGo(
          id,
          row.threadId,
          () => relocations.advance(this.deps.db, id, row.phase, "done"),
          () => this.step("let go"),
        );
      else relocations.advance(this.deps.db, id, row.phase, phase, error);
      if (phase === "done" || phase === "abandoned") this.warned.delete(id);
      this.step(phase);
      this.deps.changed(row.threadId);
    });
    this.settling.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }
}
