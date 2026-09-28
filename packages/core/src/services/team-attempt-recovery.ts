import { teamContexts, teamRuntime } from "@openorc/db";
import { type TeamActionAvailability, type TeamAttemptRecord, type TeamContextCheckpoint, type TeamExecutionRecord } from "@openorc/protocol";
import { buildTeamContextSeed, type TeamContextScope } from "./team-context.js";
import { activeClaims, errorText, terminal, type TeamCore, type TeamExecutionRef } from "./team-core.js";
import { moveActor, moveAttempt, moveExecution } from "./team-states.js";

import type { TeamCoordinatorHooks } from "./team-coordinator.js";
type StageServices = Pick<TeamCore, "db" | "runs" | "hooks" | "turns" | "delivery" | "teamChat" | "scheduler" | "status" | "recordOf" | "changed" | "now" | "assertAccepting"> & {
  hooks: TeamCoordinatorHooks;
  stopping: Map<string, Promise<void>>;
  pending: Set<Promise<void>>;
  isClosing(): boolean;
  setClosing(): void;
  freshRetryReplay(executionId: string, actorId: string, requestKey: string): boolean;
  contextScope(record: TeamExecutionRecord, actorId: string): TeamContextScope;
  auditContext(threadId: string, checkpoint: TeamContextCheckpoint): void;
};

export class TeamAttemptRecovery {
  constructor(private readonly services: StageServices) {}

  retryAvailability(execution: TeamExecutionRef, actorId: string): TeamActionAvailability {
    const deny = (reason: string) => ({ allowed: false, reason });
    if (this.services.isClosing()) return deny("Team coordination is shutting down.");
    const current = this.services.recordOf(execution);
    if (this.services.stopping.has(current.id)) return deny("Wait for the team stop operation to finish before retrying.");
    try {
      this.services.hooks.assertThreadAvailable?.(current.threadId, { retainedTask: true });
    } catch (error) {
      return deny(errorText(error));
    }
    if (!["active", "attention"].includes(current.state)) return deny("This execution cannot be retried.");
    if (current.deadlineAt <= this.services.now()) return deny("This execution reached its time limit. Stop it before starting new work.");
    const actor = current.actors.find((item) => item.id === actorId);
    if (!actor || actor.state !== "attention") return deny("Only an assignment requiring attention can be retried.");
    // A restart is not the agent's failure, so retrying the turn it interrupted is not counted.
    if (!actor.interrupted && actor.retries + 1 >= current.limits.maxAttemptsPerAssignment) return deny("This assignment reached its retry limit.");
    if (current.attempts.some((attempt) => attempt.actorId === actorId && this.services.turns.writing(attempt))) return deny("The previous writer has not finished closing.");
    return { allowed: true, reason: null };
  }

  retry(executionId: string, actorId: string, options: { fresh?: boolean; requestKey?: string } = {}): void {
    this.services.assertAccepting();
    if (options.requestKey !== undefined && !options.fresh) throw new Error("A context request key requires a fresh retry.");
    if (options.fresh) {
      if (!options.requestKey) throw new Error("A fresh retry needs a request key.");
      if (this.services.freshRetryReplay(executionId, actorId, options.requestKey)) return;
    }
    const availability = this.retryAvailability(executionId, actorId);
    if (!availability.allowed) throw new Error(availability.reason!);
    const { record } = teamRuntime.update(this.services.db, executionId, (state) => {
      const target = state.actors.find((item) => item.id === actorId)!;
      if (!target.interrupted && target.retries + 1 >= state.limits.maxAttemptsPerAssignment) throw new Error("This assignment reached its retry limit.");
      if (options.fresh) {
        const scope = this.services.contextScope(state, actorId);
        const checkpoint = teamContexts.create(this.services.db, {
          ...scope,
          originExecutionId: executionId,
          reason: "fresh_retry",
          requestKey: options.requestKey!,
          seed: buildTeamContextSeed(this.services.db, scope, executionId),
        });
        this.services.auditContext(state.threadId, checkpoint);
      }
      if (target.interrupted) delete target.interrupted;
      else target.retries += 1;
      moveActor(target, "queued");
      target.error = null;
      target.disposition = null;
      // An explicit retry acknowledges interrupted work only after the previous
      // in-process writer/setup barriers are gone. Preserve its immutable history.
      for (const attempt of state.attempts)
        if (attempt.actorId === actorId && attempt.state === "attention" && attempt.endedAt === null) {
          moveAttempt(attempt, "cancelled");
          attempt.endedAt = this.services.now();
        }
      for (const message of state.messages)
        if (message.recipientId === actorId && message.state === "claimed") {
          message.state = "pending";
          message.attemptId = null;
        }
      moveExecution(state, "active");
      state.error = null;
    });
    this.services.scheduler.armDeadline(record);
    this.services.changed(record);
    this.services.scheduler.schedule();
  }

  /** Fence first; late startup, tools and result callbacks cannot admit more work. */
  stop(executionId: string): Promise<void> {
    const pending = this.services.stopping.get(executionId);
    if (pending) return pending;
    this.services.assertAccepting();
    const operation = this.stopExecution(executionId).finally(() => {
      this.services.stopping.delete(executionId);
      this.services.hooks.changed(this.services.status(executionId).threadId);
    });
    this.services.stopping.set(executionId, operation);
    return operation;
  }

  private async stopExecution(executionId: string): Promise<void> {
    const current = this.services.status(executionId);
    if (current.state === "stopped" || current.state === "completed") return;
    const { record } = teamRuntime.update(this.services.db, executionId, (state) => {
      state.generation += 1;
      moveExecution(state, "stopping");
      for (const actor of state.actors)
        if (!terminal(actor.state)) {
          moveActor(actor, "cancelled");
          actor.disposition = null;
          actor.ambient = null;
        }
      for (const claim of activeClaims(state)) claim.releasedAt = this.services.now();
    });
    this.services.scheduler.clearDeadline(executionId);
    this.services.changed(record);
    this.services.teamChat.dropCapture(executionId);
    for (const attempt of record.attempts) if (attempt.runId) this.services.turns.cool(attempt.runId);
    let failure: string | null = null;
    const barriers = this.services.turns.barriers(record);
    barriers.push(
      ...[...new Set(record.attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])))].map((runId) => this.services.runs.closeAndWait(runId, this.services.hooks.closeTimeoutMs)),
    );
    barriers.push(...(this.services.hooks.workspace?.recoveries?.(executionId) ?? []));
    try {
      await this.bounded(Promise.all(barriers), this.services.hooks.closeTimeoutMs ?? 10_000);
      this.services.hooks.workspace?.assertStopped?.(executionId);
    } catch (error) {
      failure = errorText(error);
    }
    const saved = teamRuntime.update(this.services.db, executionId, (state) => {
      if (state.generation !== record.generation || state.state !== "stopping") return;
      moveExecution(state, failure ? "attention" : "stopped");
      state.error = failure;
      for (const attempt of state.attempts)
        if (["starting", "running", "attention"].includes(attempt.state)) {
          moveAttempt(attempt, failure ? "attention" : "cancelled");
          attempt.error = failure;
          attempt.endedAt = failure ? null : this.services.now();
        }
      if (failure)
        for (const actor of state.actors)
          if (actor.state === "cancelled") {
            moveActor(actor, "attention");
            actor.error = failure;
          }
    }).record;
    this.services.changed(saved);
    if (failure) throw new Error(failure);
  }

  /**
   * Called at core startup, before any tool can authorize a previous run, and again at shutdown. Every previous run
   * loses its authority. Only turns whose provider had started can have done something nobody saw, so only they wait
   * for inspection; work that was queued, waiting or not yet started simply continues. Each execution recovers on
   * its own: one that cannot be read or updated is reported and never stops the others or the app.
   */
  recover(): void {
    const restarted = "OpenOrc restarted during this turn. Inspect its work before retrying; no side effects were replayed.";
    for (const id of teamRuntime.openIds(this.services.db)) {
      try {
        const { record } = teamRuntime.update(this.services.db, id, (state) => this.recoverExecution(state, restarted));
        this.services.changed(record);
        if (this.services.isClosing()) continue;
        this.services.scheduler.armDeadline(record);
        this.services.teamChat.resumeCapture(record);
      } catch (error) {
        this.services.scheduler.fault(id, error);
      }
    }
    if (!this.services.isClosing()) this.services.scheduler.schedule();
  }

  private recoverExecution(state: TeamExecutionRecord, restarted: string): void {
    state.generation += 1;
    const now = this.services.now();
    for (const attempt of state.attempts) {
      if (!["starting", "running"].includes(attempt.state)) continue;
      this.recoverAttempt(state, attempt, restarted, now);
    }
    for (const actor of state.actors) {
      // Pending reads are not restored: the room slice of a member's next turn carries whatever it missed.
      actor.ambient = null;
      // A turn whose journal lost track of its attempt is treated as interrupted too.
      if (actor.state === "starting" || actor.state === "running") {
        moveActor(actor, "attention");
        actor.disposition = null;
        actor.error = restarted;
        actor.interrupted = true;
      }
    }
    if (state.state === "stopping") {
      // The stop was cut short; its writers are gone, but its end was never recorded.
      moveExecution(state, "attention");
      state.error = "OpenOrc restarted while this team was stopping. Stop it again to finish.";
    } else if (state.actors.some((actor) => actor.state === "attention")) {
      moveExecution(state, "attention");
      state.error ??= restarted;
    }
  }

  private recoverAttempt(state: TeamExecutionRecord, attempt: TeamAttemptRecord, restarted: string, now: number): void {
    const actor = state.actors.find((item) => item.id === attempt.actorId)!;
    if (attempt.runId === null && !this.services.turns.isLaunching(attempt.id)) {
      // The provider never started, so nothing ran: release its input and queue it again.
      this.services.delivery.settleRoomDelivery(attempt, "cancelled", "OpenOrc restarted before this turn started.");
      moveAttempt(attempt, "cancelled");
      attempt.error = "OpenOrc restarted before this turn started.";
      attempt.endedAt = now;
      for (const message of state.messages)
        if (message.attemptId === attempt.id && message.state === "claimed") {
          message.state = "pending";
          message.attemptId = null;
        }
      if (!terminal(actor.state)) {
        moveActor(actor, "queued");
        actor.disposition = null;
      }
      return;
    }
    this.services.delivery.settleRoomDelivery(attempt, "uncertain", restarted);
    moveAttempt(attempt, "attention");
    attempt.error = restarted;
    for (const receipt of attempt.liveDirections ?? [])
      if (receipt.state === "reserved") {
        receipt.state = "uncertain";
        receipt.settledAt = Math.max(now, receipt.createdAt);
        receipt.error = "OpenOrc restarted before live delivery was confirmed. Inspect the turn before explicitly retrying.";
      }
    if (!terminal(actor.state)) {
      moveActor(actor, "attention");
      actor.disposition = null;
      actor.error = restarted;
      actor.interrupted = true;
    }
  }

  async drain(): Promise<void> {
    while (this.services.pending.size) await Promise.all([...this.services.pending]);
  }

  async shutdown(): Promise<void> {
    this.services.setClosing();
    this.services.turns.coolAll();
    this.services.teamChat.dropCapture();
    this.services.scheduler.shutdown();
    const open = this.services.scheduler.openExecutions();
    this.recover();
    const barriers = [...this.services.stopping.values(), ...this.services.turns.all()];
    barriers.push(
      ...open.flatMap((record) =>
        [...new Set(record.attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])))].map((runId) => this.services.runs.closeAndWait(runId, this.services.hooks.closeTimeoutMs)),
      ),
    );
    await this.bounded(Promise.all(barriers), this.services.hooks.closeTimeoutMs ?? 10_000);
    await this.bounded(this.drain(), this.services.hooks.closeTimeoutMs ?? 10_000);
  }

  track(operation: Promise<void>): void {
    this.services.pending.add(operation);
    void operation.finally(() => this.services.pending.delete(operation)).catch(() => {});
  }

  private async bounded<T>(operation: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Team stop could not confirm that all preparation and writers finished. Inspect recovery before retrying.")), timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
