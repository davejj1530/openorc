import { audit, orchestration, runs as runRows, teamContextParts, teamContexts, teamRuntime, teamWorkspaces, threads, type Db } from "@openorc/db";
import {
  LeadOverrides,
  type HarnessId,
  type ModelExecutionSettings,
  type Project,
  type Run,
  type Task,
  type TeamActionAvailability,
  type TeamActorRecord,
  type TeamAttemptRecord,
  type TeamContextCheckpoint,
  type TeamExecutionRecord,
  type TeamRevision,
  type TeamRunBinding,
} from "@openorc/protocol";
import { RunService, type RunScope, type StartRunInput, type TurnSettledOutcome } from "./runs.js";
import { TeamAssignments } from "./team-assignments.js";
import { TeamAttemptAdmission } from "./team-attempt-admission.js";
import { TeamAttemptLaunch } from "./team-attempt-launch.js";
import { TeamAttemptRecovery } from "./team-attempt-recovery.js";
import { TeamAttemptSettlement } from "./team-attempt-settlement.js";
import { TeamChat } from "./team-chat.js";
import { buildTeamContextSeed, teamContextExecutions, type TeamContextScope } from "./team-context.js";
import { errorText, type TeamCore, type TeamExecutionRef } from "./team-core.js";
import { TeamDelivery } from "./team-delivery.js";
import { TeamRoomService } from "./team-room.js";
import { TeamScheduler } from "./team-scheduler.js";
import { moveActor, moveExecution } from "./team-states.js";
import { TeamTurns } from "./team-turns.js";

export interface TeamCoordinatorHooks {
  /** Synchronous admission check shared with non-provider workspace mutations. A retained task may reach a deleted owner. */
  assertThreadAvailable?(threadId: string, options?: { retainedTask?: boolean }): void;
  /** Must finish preparation before returning and check admission around its asynchronous steps. */
  prepare(task: Task, assertActive: () => void): Promise<Task>;
  validate(settings: ModelExecutionSettings, projectId: string): Promise<void>;
  changed(threadId: string, record?: TeamExecutionRecord): void;
  /** Reports a contained failure: one execution could not be read or advanced and is skipped until it changes. */
  warn?(message: string): void;
  now?: () => number;
  closeTimeoutMs?: number;
  /** Optional hard ceilings across teams; unspecified providers have no additional concurrency limit. */
  providerLimits?: Partial<Record<HarnessId, number>>;
  workspace?: {
    beforeStart(executionId: string, actorId: string, assertActive: () => void): Promise<void>;
    captureOutput(executionId: string, actorId: string, assertActive: () => void): Promise<void>;
    assertStopped?(executionId: string): void;
    /** Explicit setup/integration recoveries still running; Stop waits for them. */
    recoveries?(executionId: string): Promise<void>[];
  };
  tasks?: {
    instructions(record: TeamExecutionRecord, actor: TeamActorRecord): string;
    completionReason(record: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord): string | null;
    hasPendingWork?(record: TeamExecutionRecord, actor: TeamActorRecord): boolean;
    /** Synchronous, after journal settlement in the same transaction. Revoked turns are excluded. */
    settled(record: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, outcome: TurnSettledOutcome): void;
  };
}

export interface ReserveTeamTaskInput {
  taskId: string;
  memberKey: string;
  requestKey: string;
  input: { title: string; spec: string; attachments: string[] };
  dependencies?: string[];
}

export interface TeamStartPlan {
  revision: TeamRevision;
  settings: ModelExecutionSettings;
  leadOverrides: LeadOverrides;
  allowArchived?: boolean;
}

/**
 * Durable coordination for the pinned team hierarchy. Provider transcripts stay
 * in RunService; this journal holds bounded direction and results, not every
 * member's token stream. Each manager yields before its direct reports start.
 */
export class TeamCoordinator implements TeamCore {
  private readonly pending = new Set<Promise<void>>();
  /** Turns in flight in this process: launches, settlements, live deliveries and warm member sessions. */
  readonly turns: TeamTurns;
  readonly stopping = new Map<string, Promise<void>>();
  closing = false;
  readonly room: TeamRoomService;
  /** The parts, each owning one concern: mailbox and live delivery, team chat, delegated assignments, and scheduling. */
  readonly delivery: TeamDelivery;
  readonly teamChat: TeamChat;
  readonly assignments: TeamAssignments;
  readonly scheduler: TeamScheduler;
  private readonly admissionStage: TeamAttemptAdmission;
  private readonly launchStage: TeamAttemptLaunch;
  private readonly settlementStage: TeamAttemptSettlement;
  private readonly recoveryStage: TeamAttemptRecovery;

  constructor(
    readonly db: Db,
    readonly runs: RunService,
    readonly hooks: TeamCoordinatorHooks,
  ) {
    this.room = new TeamRoomService(db);
    this.turns = new TeamTurns(runs);
    this.delivery = new TeamDelivery(this);
    this.teamChat = new TeamChat(this);
    this.assignments = new TeamAssignments(this);
    this.scheduler = new TeamScheduler(this);
    this.admissionStage = new TeamAttemptAdmission({
      db,
      runs,
      hooks,
      room: this.room,
      delivery: this.delivery,
      teamChat: this.teamChat,
      scheduler: this.scheduler,
      now: () => this.now(),
      assertAccepting: () => this.assertAccepting(),
      assertGeneration: (record, generation) => this.assertGeneration(record, generation),
      changed: (record) => this.changed(record),
    });
    this.launchStage = new TeamAttemptLaunch({
      db,
      runs,
      hooks,
      room: this.room,
      turns: this.turns,
      delivery: this.delivery,
      teamChat: this.teamChat,
      scheduler: this.scheduler,
      now: () => this.now(),
      status: (id) => this.status(id),
      changed: (record) => this.changed(record),
      assertGeneration: (record, generation) => this.assertGeneration(record, generation),
      attention: (record, actor, error) => this.attention(record, actor, error),
      track: (operation) => this.track(operation),
      contextScope: (record, actorId) => this.contextScope(record, actorId),
    });
    this.settlementStage = new TeamAttemptSettlement({
      db,
      runs,
      hooks,
      turns: this.turns,
      stopping: this.stopping,
      delivery: this.delivery,
      teamChat: this.teamChat,
      assignments: this.assignments,
      scheduler: this.scheduler,
      binding: (id) => this.binding(id),
      status: (id) => this.status(id),
      track: (operation) => this.track(operation),
      changed: (record) => this.changed(record),
      now: () => this.now(),
      assertGeneration: (record, generation) => this.assertGeneration(record, generation),
      attention: (record, actor, error) => this.attention(record, actor, error),
    });
    this.recoveryStage = new TeamAttemptRecovery({
      db,
      runs,
      hooks,
      turns: this.turns,
      stopping: this.stopping,
      delivery: this.delivery,
      teamChat: this.teamChat,
      scheduler: this.scheduler,
      status: (id) => this.status(id),
      recordOf: (execution) => this.recordOf(execution),
      changed: (record) => this.changed(record),
      now: () => this.now(),
      assertAccepting: () => this.assertAccepting(),
      freshRetryReplay: (id, actorId, key) => this.freshRetryReplay(id, actorId, key),
      contextScope: (record, actorId) => this.contextScope(record, actorId),
      auditContext: (threadId, checkpoint) => this.auditContext(threadId, checkpoint),
      pending: this.pending,
      isClosing: () => this.closing,
      setClosing: () => {
        this.closing = true;
      },
    });
  }

  // The parts' public operations, kept on the coordinator so callers depend on one team API.
  dispatch(...args: Parameters<TeamAssignments["dispatch"]>): ReturnType<TeamAssignments["dispatch"]> {
    return this.assignments.dispatch(...args);
  }
  dispatchReplay(...args: Parameters<TeamAssignments["dispatchReplay"]>): ReturnType<TeamAssignments["dispatchReplay"]> {
    return this.assignments.dispatchReplay(...args);
  }
  reserveTask(...args: Parameters<TeamAssignments["reserveTask"]>): ReturnType<TeamAssignments["reserveTask"]> {
    return this.assignments.reserveTask(...args);
  }
  wait(...args: Parameters<TeamAssignments["wait"]>): ReturnType<TeamAssignments["wait"]> {
    return this.assignments.wait(...args);
  }
  complete(...args: Parameters<TeamAssignments["complete"]>): ReturnType<TeamAssignments["complete"]> {
    return this.assignments.complete(...args);
  }
  message(...args: Parameters<TeamDelivery["message"]>): ReturnType<TeamDelivery["message"]> {
    return this.delivery.message(...args);
  }
  messageFromThread(...args: Parameters<TeamDelivery["messageFromThread"]>): ReturnType<TeamDelivery["messageFromThread"]> {
    return this.delivery.messageFromThread(...args);
  }
  steer(...args: Parameters<TeamDelivery["steer"]>): ReturnType<TeamDelivery["steer"]> {
    return this.delivery.steer(...args);
  }
  steerAvailability(...args: Parameters<TeamDelivery["steerAvailability"]>): ReturnType<TeamDelivery["steerAvailability"]> {
    return this.delivery.steerAvailability(...args);
  }
  providerReady(...args: Parameters<TeamDelivery["providerReady"]>): ReturnType<TeamDelivery["providerReady"]> {
    return this.delivery.providerReady(...args);
  }
  steerActor(...args: Parameters<TeamDelivery["steerActor"]>): ReturnType<TeamDelivery["steerActor"]> {
    return this.delivery.steerActor(...args);
  }
  cancelDirectionAvailability(...args: Parameters<TeamDelivery["cancelDirectionAvailability"]>): ReturnType<TeamDelivery["cancelDirectionAvailability"]> {
    return this.delivery.cancelDirectionAvailability(...args);
  }
  sendNowAvailability(...args: Parameters<TeamDelivery["sendNowAvailability"]>): ReturnType<TeamDelivery["sendNowAvailability"]> {
    return this.delivery.sendNowAvailability(...args);
  }
  sendNow(...args: Parameters<TeamDelivery["sendNow"]>): ReturnType<TeamDelivery["sendNow"]> {
    return this.delivery.sendNow(...args);
  }
  cancelDirection(...args: Parameters<TeamDelivery["cancelDirection"]>): ReturnType<TeamDelivery["cancelDirection"]> {
    return this.delivery.cancelDirection(...args);
  }
  assertCurrentDirection(...args: Parameters<TeamDelivery["assertCurrentDirection"]>): ReturnType<TeamDelivery["assertCurrentDirection"]> {
    return this.delivery.assertCurrentDirection(...args);
  }
  chatRecipients(...args: Parameters<TeamChat["chatRecipients"]>): ReturnType<TeamChat["chatRecipients"]> {
    return this.teamChat.chatRecipients(...args);
  }
  chat(...args: Parameters<TeamChat["chat"]>): ReturnType<TeamChat["chat"]> {
    return this.teamChat.chat(...args);
  }
  say(...args: Parameters<TeamChat["say"]>): ReturnType<TeamChat["say"]> {
    return this.teamChat.say(...args);
  }
  claim(...args: Parameters<TeamChat["claim"]>): ReturnType<TeamChat["claim"]> {
    return this.teamChat.claim(...args);
  }
  activityReason(...args: Parameters<TeamScheduler["activityReason"]>): ReturnType<TeamScheduler["activityReason"]> {
    return this.scheduler.activityReason(...args);
  }
  faultReason(...args: Parameters<TeamScheduler["faultReason"]>): ReturnType<TeamScheduler["faultReason"]> {
    return this.scheduler.faultReason(...args);
  }

  now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  binding(runId: string): TeamRunBinding | null {
    return teamRuntime.binding(this.db, runId);
  }

  /** All ordinary run start paths share this guard, including queue drains and review follow-ups. */
  assertLaunch(input: StartRunInput): void {
    return this.admissionStage.assertLaunch(input);
  }

  /** Requested mode is persisted by ThreadService; running turns retain their actual mode. */
  modeChanged(threadId: string): void {
    const current = teamRuntime.activeForThread(this.db, threadId);
    if (!current) return;
    if (threads.get(this.db, threadId)?.mode === "act" && ["active", "attention"].includes(current.state)) {
      const lead = current.actors.find((actor) => actor.id === "lead")!;
      if (lead.state === "waiting" && lead.modeHold === "plan") {
        teamRuntime.update(this.db, current.id, (state) => {
          const actor = state.actors.find((item) => item.id === "lead")!;
          moveActor(actor, "queued");
          actor.disposition = null;
          delete actor.modeHold;
        });
      }
    }
    this.hooks.changed(threadId);
    this.scheduler.schedule();
  }

  recordOf(execution: TeamExecutionRef): TeamExecutionRecord {
    return typeof execution === "string" ? this.status(execution) : execution;
  }

  status(executionId: string): TeamExecutionRecord {
    const record = teamRuntime.get(this.db, executionId);
    if (!record) throw new Error("Team execution not found.");
    return record;
  }

  private contextScope(record: TeamExecutionRecord, actorId: string): TeamContextScope {
    if (!record.actors.some((actor) => actor.id === actorId)) throw new Error("Assignment not found in this execution.");
    return { instanceId: record.instanceId, executionId: actorId === "lead" ? null : record.id, actorId };
  }

  private assertContextKey(requestKey: string): void {
    if (!requestKey.trim() || requestKey.length > 200) throw new Error("Context operations need a bounded request key.");
  }

  freshRetryReplay(executionId: string, actorId: string, requestKey: string): boolean {
    this.assertContextKey(requestKey);
    const record = this.status(executionId);
    const previous = teamContexts.findRequest(this.db, { ...this.contextScope(record, actorId), requestKey });
    if (!previous) return false;
    if (previous.reason !== "fresh_retry" || previous.originExecutionId !== executionId) throw new Error("This context request key already identifies a different operation.");
    return true;
  }

  assertQuiescent(threadId: string): void {
    this.assertAccepting();
    const instance = orchestration.getInstance(this.db, threadId);
    if (!instance) throw new Error("This conversation has no saved team.");
    if (teamRuntime.activeForThread(this.db, threadId)) throw new Error("Finish or stop the team's current execution before changing its workspace or context.");
    const history = teamContextExecutions(this.db, instance.id);
    if (this.runs.liveRunForThread(threadId)) throw new Error("The previous lead process has not finished closing.");
    for (const record of history) {
      if (this.stopping.has(record.id) || this.turns.launchingIn(record.id) || record.attempts.some((attempt) => this.turns.writing(attempt)))
        throw new Error("Wait for all team preparation and writers to finish before changing its workspace or context.");
      if (teamWorkspaces.publications(this.db, record.id).some((receipt) => receipt.state !== "applied"))
        throw new Error("Retained output needs integration recovery before changing its workspace or context.");
      this.hooks.workspace?.assertStopped?.(record.id);
    }
  }

  /** Explicit workspace recovery runs outside a provider turn but inside this execution's generation. */
  recoveryContext(execution: TeamExecutionRef): { assertActive(): void; assertActorIdle(actorId: string): void } {
    const { id: executionId, generation } = this.recordOf(execution);
    return {
      assertActive: () => {
        this.assertAccepting();
        const current = this.status(executionId);
        if (!["active", "attention"].includes(current.state) || current.generation !== generation || this.stopping.has(executionId))
          throw new Error("This execution was stopped or replaced. Recovery did not continue; its files were preserved.");
      },
      assertActorIdle: (actorId) => {
        const current = this.status(executionId);
        if (!["active", "attention"].includes(current.state) || this.stopping.has(executionId)) throw new Error("This execution is not open for recovery.");
        const reason = this.actorIdleReason(executionId, actorId);
        if (reason) throw new Error(reason);
      },
    };
  }

  /** Null when the assignment has no starting, running or launching attempt and no writer still closing. */
  actorIdleReason(executionId: string, actorId: string): string | null {
    if (this.closing) return "Team coordination is shutting down.";
    if (this.stopping.has(executionId)) return "Wait for the team stop operation to finish.";
    const current = this.status(executionId);
    const actor = current.actors.find((item) => item.id === actorId);
    if (!actor) return "Assignment not found in this execution.";
    if (actorId === "lead" && this.teamChat.capturePending(executionId)) return "Wait for this conversation's workspace capture to finish.";
    if (
      ["starting", "running"].includes(actor.state) ||
      current.attempts.some((attempt) => attempt.actorId === actorId && (["starting", "running"].includes(attempt.state) || this.turns.writing(attempt)))
    )
      return "Wait for this team assignment's current turn and writers to finish first.";
    return null;
  }

  compactAvailability(threadId: string): TeamActionAvailability {
    try {
      this.hooks.assertThreadAvailable?.(threadId, { retainedTask: true });
      this.assertQuiescent(threadId);
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: errorText(error) };
    }
  }

  compact(threadId: string, requestKey: string): TeamContextCheckpoint {
    this.assertAccepting();
    this.assertContextKey(requestKey);
    const instance = orchestration.getInstance(this.db, threadId);
    if (!instance) throw new Error("This conversation has no saved team.");
    const scope = { instanceId: instance.id, executionId: null, actorId: "lead" };
    const checkpoint = this.db.transaction(() => {
      const previous = teamContexts.findRequest(this.db, { ...scope, requestKey });
      if (previous) {
        if (previous.reason !== "compact") throw new Error("This context request key already identifies a different operation.");
        return previous;
      }
      this.hooks.assertThreadAvailable?.(threadId, { retainedTask: true });
      this.assertQuiescent(threadId);
      const created = teamContexts.create(this.db, { ...scope, originExecutionId: null, reason: "compact", requestKey, seed: buildTeamContextSeed(this.db, scope) });
      this.auditContext(threadId, created);
      // Quiescent compaction is the moment stored overflow from superseded rebuilds can go.
      teamContextParts.prune(this.db, instance.id);
      return created;
    });
    this.hooks.changed(threadId);
    return checkpoint;
  }

  private auditContext(threadId: string, checkpoint: TeamContextCheckpoint): void {
    audit.record(this.db, {
      actor: "user",
      action: `team.context.${checkpoint.reason}`,
      resourceType: "thread",
      resourceId: threadId,
      metadata: {
        checkpointId: checkpoint.id,
        instanceId: checkpoint.instanceId,
        executionId: checkpoint.executionId,
        actorId: checkpoint.actorId,
        originExecutionId: checkpoint.originExecutionId,
        reason: checkpoint.reason,
      },
    });
  }

  async validateStart(input: { projectId: string; teamRevisionId: string; leadOverrides?: LeadOverrides; allowArchived?: boolean }): Promise<TeamStartPlan> {
    return this.admissionStage.validateStart(input);
  }

  async validateLeadSettings(threadId: string, overrides: LeadOverrides): Promise<ModelExecutionSettings> {
    return this.admissionStage.validateLeadSettings(threadId, overrides);
  }

  async start(input: { threadId: string; teamRevisionId?: string; initialLeadOverrides?: LeadOverrides; prompt: string; attachments?: string[] }): Promise<TeamExecutionRecord> {
    return this.admissionStage.start(input);
  }

  /** Synchronous admission composes with new-thread creation in the same transaction. */
  admit(input: {
    threadId: string;
    prompt: string;
    attachments?: string[];
    plan: TeamStartPlan;
    expectedConfigurationVersion?: number;
    admission?: TeamExecutionRecord["admission"];
    sourceTaskAdmissionId?: string;
    /** Participant actor ids the opening message addresses. The lead starts only when it is among them; absent means the lead. */
    addressed?: string[];
    requestKey?: string;
  }): TeamExecutionRecord {
    return this.admissionStage.admit(input);
  }

  /**
   * Authority comes exclusively from the immutable Run binding, never a supplied actor ID. The binding names the
   * process and its owner; a conversation member's process serves several turns, so the turn is the newest one on it.
   * A call that arrives while the process sits between turns belongs to a turn that has ended, and is refused.
   */
  actorFor(runId: string) {
    this.assertAccepting();
    const binding = this.binding(runId);
    if (!binding) throw new Error("This run is not part of a team execution.");
    const record = this.status(binding.executionId);
    this.assertGeneration(record, binding.generation);
    const actor = record.actors.find((item) => item.id === binding.actorId);
    const attempt = record.attempts.findLast((item) => item.runId === runId);
    const run = runRows.get(this.db, runId);
    if (
      !actor ||
      !attempt ||
      attempt.actorId !== binding.actorId ||
      !["starting", "running"].includes(attempt.state) ||
      !["starting", "running"].includes(actor.state) ||
      !this.runs.isLive(runId) ||
      !this.runs.isBusy(runId) ||
      this.turns.isSettling(attempt.id) ||
      !run
    )
      throw new Error("This team run no longer has active authority.");
    return { binding, record, actor, attempt, run };
  }

  statusForRun(runId: string): TeamExecutionRecord {
    return this.actorFor(runId).record;
  }

  /**
   * Team input reaches a process only as a turn this coordinator reserved on it. Everything else, including the
   * renderer's own send path, still has to go through the durable mailbox.
   */
  assertSend(runId: string, teamAttemptId: string | undefined): void {
    const binding = this.binding(runId);
    if (!binding) return;
    if (!teamAttemptId) throw new Error("Team direction must go through the durable mailbox.");
    const record = this.status(binding.executionId);
    const attempt = record.attempts.find((item) => item.id === teamAttemptId);
    // The turn is bound to the process once the provider takes it, so a turn on its way in is still unbound.
    if (!attempt || attempt.actorId !== binding.actorId || attempt.state !== "starting" || (attempt.runId !== null && attempt.runId !== runId))
      throw new Error("This is not a reserved turn of that team process.");
    this.assertGeneration(record, attempt.generation);
  }

  /** A page of the caller's room, oldest first; reading never moves the caller's delivery cursor. */
  history(runId: string, input: { afterSeq?: number; beforeSeq?: number; limit?: number }) {
    const caller = this.actorFor(runId);
    return this.room.history(caller.record.instanceId, input);
  }

  /** Verbatim history a seed stored by id; readable only by the team that owns it, during a live turn. */
  contextPart(runId: string, id: string): { id: string; bytes: number; text: string } {
    const { record } = this.actorFor(runId);
    const part = teamContextParts.get(this.db, record.instanceId, id);
    if (!part) throw new Error("No stored context text with this id belongs to your team.");
    return { id: part.id, bytes: part.bytes, text: part.content };
  }

  retryAvailability(execution: TeamExecutionRef, actorId: string): TeamActionAvailability {
    return this.recoveryStage.retryAvailability(execution, actorId);
  }

  retry(executionId: string, actorId: string, options: { fresh?: boolean; requestKey?: string } = {}): void {
    return this.recoveryStage.retry(executionId, actorId, options);
  }

  onTurnSettled(run: Run, _scope: RunScope, _project: Project, outcome: TurnSettledOutcome): void {
    return this.settlementStage.onTurnSettled(run, _scope, _project, outcome);
  }

  /** Fence first; late startup, tools and result callbacks cannot admit more work. */
  stop(executionId: string): Promise<void> {
    return this.recoveryStage.stop(executionId);
  }

  /**
   * Called at core startup, before any tool can authorize a previous run, and again at shutdown. Every previous run
   * loses its authority. Only turns whose provider had started can have done something nobody saw, so only they wait
   * for inspection; work that was queued, waiting or not yet started simply continues. Each execution recovers on
   * its own: one that cannot be read or updated is reported and never stops the others or the app.
   */
  recover(): void {
    return this.recoveryStage.recover();
  }

  async drain(): Promise<void> {
    return this.recoveryStage.drain();
  }

  async shutdown(): Promise<void> {
    return this.recoveryStage.shutdown();
  }

  track(operation: Promise<void>): void {
    return this.recoveryStage.track(operation);
  }

  launch(executionId: string, actorId: string): void {
    return this.launchStage.launch(executionId, actorId);
  }

  attention(record: TeamExecutionRecord, actor: TeamActorRecord, error: string): void {
    moveActor(actor, "attention");
    actor.error = error;
    actor.disposition = null;
    delete actor.interrupted;
    moveExecution(record, "attention");
    record.error = error;
    if (actor.parentId) {
      try {
        this.delivery.enqueueMessage(record, {
          senderId: actor.id,
          recipientId: actor.parentId,
          kind: "result",
          body: `${actor.input.title} needs attention: ${error}`,
          dedupeKey: `attention:${actor.id}:${record.attempts.filter((attempt) => attempt.actorId === actor.id).length}`,
        });
      } catch (deliveryError) {
        record.error = `${error}\n${errorText(deliveryError)}`;
      }
    }
  }

  assertGeneration(record: TeamExecutionRecord, generation: number): void {
    this.assertAccepting();
    if (!["active", "attention"].includes(record.state) || record.generation !== generation) throw new Error("This execution was stopped or replaced. Its previous run authority is revoked.");
    if (record.deadlineAt <= this.now()) throw new Error("This execution reached its time limit.");
  }

  assertAccepting(): void {
    if (this.closing) throw new Error("Team coordination is shutting down. No new work can be admitted.");
  }

  changed(record: TeamExecutionRecord): void {
    if (["stopped", "completed"].includes(record.state)) this.scheduler.clearDeadline(record.id);
    this.scheduler.clearFault(record.id);
    this.hooks.changed(record.threadId, record);
  }
}
