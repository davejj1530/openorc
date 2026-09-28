import { runs as runRows, teamRuntime } from "@openorc/db";
import {
  teamAttemptDirectionVersion,
  teamAttemptHasUnconfirmedDirection,
  type Project,
  type Run,
  type TeamActorRecord,
  type TeamAttemptRecord,
  type TeamExecutionRecord,
  type TeamRunBinding,
} from "@openorc/protocol";
import { type RunScope, type TurnSettledOutcome } from "./runs.js";
import { assignmentsOf, conversant, errorText, type TeamCore } from "./team-core.js";
import { moveAttempt } from "./team-states.js";

import type { TeamCoordinatorHooks } from "./team-coordinator.js";
type StageServices = Pick<
  TeamCore,
  "db" | "runs" | "hooks" | "turns" | "stopping" | "delivery" | "teamChat" | "assignments" | "scheduler" | "binding" | "status" | "track" | "changed" | "now" | "assertGeneration" | "attention"
> & { hooks: TeamCoordinatorHooks };

type RoomDeliveryState = "confirmed" | "cancelled" | "uncertain";

/** The provider's completed turn outranks later capture status only after a clean process close. */
export function roomDeliveryDecision(closeError: string | null, outcome: TurnSettledOutcome): RoomDeliveryState {
  if (!closeError && outcome.turnStatus !== undefined) {
    if (outcome.turnStatus === "success") return "confirmed";
    if (outcome.turnStatus === "cancelled") return "cancelled";
    return "uncertain";
  }
  if (!closeError && outcome.status === "success") return "confirmed";
  if (outcome.status === "cancelled") return "cancelled";
  return "uncertain";
}

interface SettlementContext {
  binding: TeamRunBinding;
  outcome: TurnSettledOutcome;
  closeError: string | null;
  current: TeamExecutionRecord;
  changedFiles: string[] | undefined;
  planningLead: boolean;
  completionError: string | null;
}

export class TeamAttemptSettlement {
  constructor(private readonly services: StageServices) {}

  onTurnSettled(run: Run, _scope: RunScope, _project: Project, outcome: TurnSettledOutcome): void {
    const owner = this.services.binding(run.id);
    if (!owner) return;
    // A conversation member's process serves several turns; this settles the one that just ended, not the one that opened it.
    const open = this.services.status(owner.executionId).attempts.findLast((item) => item.runId === run.id && ["starting", "running"].includes(item.state));
    const binding = open ? { ...owner, attemptId: open.id, generation: open.generation } : owner;
    const settlement = this.services.turns.settle(binding.attemptId, () =>
      Promise.resolve()
        .then(() => this.settle(binding, outcome))
        .finally(() => {
          this.services.turns.settled(binding.attemptId);
          this.services.hooks.changed(this.services.status(binding.executionId).threadId);
        }),
    );
    if (settlement) this.services.track(settlement);
  }
  private async settle(binding: TeamRunBinding, outcome: TurnSettledOutcome): Promise<void> {
    const context = await this.prepareSettlement(binding, outcome);
    if (!context) return;
    let record = this.commitSettlement(context);
    this.services.changed(record);
    record = await this.services.teamChat.captureRoom(record, binding.generation);
    // Nothing more will be said in this conversation, so nobody keeps a session or a share of the workspace.
    if (["completed", "stopped"].includes(record.state)) await this.services.teamChat.closeWarmProcesses(record);
    this.services.scheduler.schedule();
  }

  private async closeProvider(binding: TeamRunBinding, outcome: TurnSettledOutcome): Promise<{ outcome: TurnSettledOutcome; closeError: string | null; finalized: Run | null }> {
    // A steer reply is drained before a normal close. Stop fences and closes immediately instead.
    await this.services.turns.delivery(binding.runId);
    const settling = this.services.status(binding.executionId);
    const actor = settling.actors.find((item) => item.id === binding.actorId);
    const warm =
      Boolean(actor?.participant) &&
      outcome.status === "success" &&
      settling.generation === binding.generation &&
      ["active", "attention"].includes(settling.state) &&
      !this.services.stopping.has(binding.executionId) &&
      this.services.runs.isLive(binding.runId);
    let closeError: string | null = null;
    if (warm) this.services.turns.keepWarm(binding.runId);
    else {
      try {
        await this.services.runs.closeAndWait(binding.runId, this.services.hooks.closeTimeoutMs);
      } catch (error) {
        closeError = errorText(error);
      }
    }
    // A fatal provider event can arrive after capture. The final process result then wins.
    const finalized = runRows.get(this.services.db, binding.runId);
    if (!warm && !closeError && outcome.status === "success" && finalized?.state !== "success") {
      outcome = {
        ...outcome,
        status: finalized?.state === "cancelled" ? "cancelled" : "error",
        error: finalized?.error ?? outcome.error ?? "The provider did not finish successfully after the turn was captured.",
      };
    }
    return { outcome, closeError, finalized };
  }

  private async prepareSettlement(binding: TeamRunBinding, initialOutcome: TurnSettledOutcome): Promise<SettlementContext | null> {
    const { outcome, closeError: processError, finalized } = await this.closeProvider(binding, initialOutcome);
    const current = this.services.status(binding.executionId);
    const actor = current.actors.find((item) => item.id === binding.actorId)!;
    const attempt = current.attempts.find((item) => item.id === binding.attemptId)!;
    if (this.alreadySettled(attempt)) return null;
    const changedFiles = await this.services.teamChat.changedFiles(current, binding, outcome.snapshotId);
    const planningLead = actor.id === "lead" && (attempt.mode ?? finalized?.mode) === "plan";
    const intendsCompletion = this.intendsCompletion(current, actor, attempt, planningLead);
    const completionError = this.completionReason(current, actor, attempt, binding, intendsCompletion);
    const closeError = await this.captureOutput(current, actor, attempt, binding, outcome, processError, completionError, intendsCompletion);
    return { binding, outcome, closeError, current, changedFiles, planningLead, completionError };
  }

  private alreadySettled(attempt: TeamAttemptRecord): boolean {
    return attempt.state === "closed" || (attempt.state === "cancelled" && attempt.endedAt !== null);
  }

  private intendsCompletion(current: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, planningLead: boolean): boolean {
    if (this.services.assignments.planningHold(current, actor, attempt) || actor.participant) return false;
    if (actor.disposition?.kind === "complete" && actor.disposition.version === teamAttemptDirectionVersion(attempt)) return true;
    return actor.id === "lead" && (assignmentsOf(current).length === 1 || planningLead) && actor.disposition === null;
  }

  private completionReason(current: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, binding: TeamRunBinding, intendsCompletion: boolean): string | null {
    if (current.generation !== binding.generation || !intendsCompletion || this.services.delivery.hasNewDirection(current, attempt)) return null;
    try {
      return this.services.hooks.tasks?.completionReason(current, actor, attempt) ?? null;
    } catch (error) {
      return `Task completion needs attention: ${errorText(error)}`;
    }
  }

  private async captureOutput(
    current: TeamExecutionRecord,
    actor: TeamActorRecord,
    attempt: TeamAttemptRecord,
    binding: TeamRunBinding,
    outcome: TurnSettledOutcome,
    closeError: string | null,
    completionError: string | null,
    intendsCompletion: boolean,
  ): Promise<string | null> {
    if (closeError || completionError || outcome.status !== "success" || !outcome.snapshotId || current.generation !== binding.generation || !intendsCompletion) return closeError;
    if (this.services.delivery.hasNewDirection(current, attempt) || !this.services.hooks.workspace) return closeError;
    // A conversation lead shares its directory with members still talking; capture when the room goes quiet.
    if (actor.id === "lead" && current.actors.some((item) => item.participant)) {
      this.services.teamChat.oweCapture(current.id);
      return closeError;
    }
    try {
      await this.services.teamChat.closeWarmProcesses(current);
      await this.services.hooks.workspace.captureOutput(current.id, actor.id, () => this.services.assertGeneration(this.services.status(current.id), binding.generation));
      return closeError;
    } catch (error) {
      return `Output capture needs attention: ${errorText(error)}`;
    }
  }

  private applySettlement(state: TeamExecutionRecord, context: SettlementContext): boolean {
    const { binding, outcome, closeError, planningLead, completionError } = context;
    const attempt = state.attempts.find((item) => item.id === binding.attemptId)!;
    if (this.alreadySettled(attempt)) return false;
    this.recordTurnResult(attempt, context);
    // A stopped or superseded generation retains turn evidence but cannot settle its actor or task.
    if (state.generation !== binding.generation || ["stopping", "stopped", "completed"].includes(state.state)) return false;
    const actor = state.actors.find((item) => item.id === binding.actorId)!;
    const captureOnlyFailure = this.captureOnlyFailure(state, actor, outcome);
    const captured = Boolean(outcome.snapshotId) || captureOnlyFailure || attempt.reason === "ambient";
    const fault = this.settlementFault(attempt, outcome, closeError, captureOnlyFailure, captured);
    if (fault) {
      this.services.attention(state, actor, fault);
      return true;
    }
    if (captureOnlyFailure) attempt.error = outcome.captureError!;
    this.deliverClaimedMessages(state, attempt);
    this.settleSuccessfulWork(state, actor, attempt, binding, outcome, planningLead, completionError);
    return true;
  }

  private recordTurnResult(attempt: TeamAttemptRecord, context: SettlementContext): void {
    const { outcome, closeError, changedFiles } = context;
    // The provider answered the input even if its later workspace snapshot failed.
    this.services.delivery.settleRoomDelivery(attempt, roomDeliveryDecision(closeError, outcome), closeError ?? outcome.error ?? null);
    moveAttempt(attempt, closeError ? "attention" : "closed");
    if (changedFiles && attempt.changedFiles === undefined) attempt.changedFiles = changedFiles;
    attempt.endedAt = closeError ? null : this.services.now();
    attempt.snapshotId = outcome.snapshotId;
    attempt.error = closeError ?? outcome.error;
  }

  private captureOnlyFailure(state: TeamExecutionRecord, actor: TeamActorRecord, outcome: TurnSettledOutcome): boolean {
    const conversation = conversant(actor) && !state.actors.some((item) => !item.participant && item.id !== "lead");
    return conversation && outcome.status === "error" && outcome.turnStatus === "success" && outcome.captureError != null && outcome.error === outcome.captureError;
  }

  private settlementFault(attempt: TeamAttemptRecord, outcome: TurnSettledOutcome, closeError: string | null, captureOnlyFailure: boolean, captured: boolean): string | null {
    if (!closeError && !teamAttemptHasUnconfirmedDirection(attempt) && (outcome.status === "success" || captureOnlyFailure) && captured) return null;
    return closeError ?? attempt.liveDirections?.find((item) => item.state === "uncertain")?.error ?? outcome.error ?? "The turn ended without a successful captured result.";
  }

  private deliverClaimedMessages(state: TeamExecutionRecord, attempt: TeamAttemptRecord): void {
    // Only a successfully captured turn proves claimed direction can leave the durable mailbox.
    for (const message of state.messages)
      if (message.attemptId === attempt.id && message.state === "claimed") {
        message.state = "delivered";
        message.deliveredAt = this.services.now();
      }
  }

  private settleSuccessfulWork(
    state: TeamExecutionRecord,
    actor: TeamActorRecord,
    attempt: TeamAttemptRecord,
    binding: TeamRunBinding,
    outcome: TurnSettledOutcome,
    planningLead: boolean,
    completionError: string | null,
  ): void {
    const fresh = !this.services.delivery.hasNewDirection(state, attempt);
    if (this.services.assignments.holdForPlan(state, actor, attempt, fresh)) return; // Hand back the plan.
    if (this.services.teamChat.settleTurn(state, actor, attempt, binding.runId, fresh)) return; // Continue the conversation.
    this.services.assignments.settleTurn(state, actor, attempt, { runId: binding.runId, snapshotId: outcome.snapshotId, fresh, planningLead, completionError });
    this.services.teamChat.completeIfIdle(state);
  }

  private commitSettlement(context: SettlementContext): TeamExecutionRecord {
    const { binding, outcome, closeError, current } = context;
    return this.services.db.transaction(() => {
      let hookError: string | null = null;
      try {
        return this.services.db.transaction(() => {
          const settled = teamRuntime.update(this.services.db, current.id, (state) => this.applySettlement(state, context));
          if (settled.value && this.services.hooks.tasks) {
            try {
              const actor = settled.record.actors.find((item) => item.id === binding.actorId)!;
              const attempt = settled.record.attempts.find((item) => item.id === binding.attemptId)!;
              const result: unknown = this.services.hooks.tasks.settled(settled.record, actor, attempt, outcome);
              if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Task settlement hooks must be synchronous.");
            } catch (error) {
              hookError = `Task settlement needs attention: ${errorText(error)}`;
              throw error;
            }
          }
          return settled.record;
        });
      } catch (error) {
        if (hookError === null) throw error;
        return this.retainHookFailure(current.id, binding, outcome, closeError, hookError);
      }
    });
  }

  private retainHookFailure(executionId: string, binding: TeamRunBinding, outcome: TurnSettledOutcome, closeError: string | null, hookError: string): TeamExecutionRecord {
    // Roll back the terminal projection and hook writes, then retain closed-turn evidence for explicit recovery.
    return teamRuntime.update(this.services.db, executionId, (state) => {
      const attempt = state.attempts.find((item) => item.id === binding.attemptId)!;
      this.services.delivery.settleRoomDelivery(attempt, "uncertain", hookError);
      moveAttempt(attempt, closeError ? "attention" : "closed");
      attempt.endedAt = closeError ? null : this.services.now();
      attempt.snapshotId = outcome.snapshotId;
      attempt.error = hookError;
      this.services.attention(
        state,
        state.actors.find((item) => item.id === binding.actorId)!,
        hookError,
      );
    }).record;
  }
}
