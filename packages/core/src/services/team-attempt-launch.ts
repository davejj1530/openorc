import { MAX_TEAM_ATTEMPTS, orchestration, projects, runs as runRows, storedReferences, tasks, teamContexts, teamRuntime, threads } from "@openorc/db";
import { normalizeModelSettings, type Run, type RunMode, type TeamActorRecord, type TeamAttemptRecord, type TeamExecutionRecord, type Thread } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { type StartRunInput } from "./runs.js";
import { buildTeamContextSeed, buildTeamCoordinationContext, teamContextExecutions, type TeamContextScope } from "./team-context.js";
import { conversant, errorText, terminal, type TeamCore } from "./team-core.js";
import { teamTurnInstructions } from "./team-instructions.js";
import { moveActor, moveAttempt } from "./team-states.js";

import { TeamModeDeferred } from "./team-attempt-admission.js";
import type { TeamCoordinatorHooks } from "./team-coordinator.js";
type StageServices = Pick<TeamCore, "db" | "runs" | "hooks" | "room" | "turns" | "delivery" | "teamChat" | "scheduler" | "now" | "status" | "changed" | "assertGeneration" | "attention" | "track"> & {
  hooks: TeamCoordinatorHooks;
  contextScope(record: TeamExecutionRecord, actorId: string): TeamContextScope;
};
interface AttemptAdmission {
  executionId: string;
  attemptId: string;
  original: TeamExecutionRecord;
  attempt: TeamAttemptRecord;
  actor: TeamActorRecord;
  reservedMode: RunMode;
  assertActive: () => void;
  assertMode: () => void;
}

interface PreparedAttempt {
  freshInput: () => StartRunInput;
  previousRunId: string | null;
  warmRunId: string | null;
}

export class TeamAttemptLaunch {
  constructor(private readonly services: StageServices) {}

  launch(executionId: string, actorId: string): void {
    // The turn's exact input is kept beside the journal, written with the reservation that claims it.
    const { record, value: attempt } = this.services.db.transaction(() => {
      const reserved = teamRuntime.update(this.services.db, executionId, (state) => this.reserveAttempt(state, actorId));
      teamRuntime.recordPrompt(this.services.db, executionId, reserved.value.attempt.id, reserved.value.prompt);
      return { record: reserved.record, value: reserved.value.attempt };
    });
    const operation = Promise.resolve()
      .then(() => this.startAttempt(record.id, attempt.id))
      .finally(() => {
        this.services.turns.launched(attempt.id);
        this.services.hooks.changed(record.threadId);
        this.services.scheduler.schedule();
      });
    this.services.turns.launching(attempt.id, executionId, operation);
    this.services.track(operation);
    this.services.changed(record);
  }

  private reserveAttempt(state: TeamExecutionRecord, actorId: string): { attempt: TeamAttemptRecord; prompt: string } {
    this.services.assertGeneration(state, state.generation);
    if (state.attempts.length >= MAX_TEAM_ATTEMPTS) throw new Error("This execution reached its turn limit.");
    const actor = state.actors.find((item) => item.id === actorId)!;
    const mode = threads.get(this.services.db, state.threadId)!.mode;
    if (actor.taskId !== null && mode !== "act") throw new TeamModeDeferred();
    const messages = state.messages.filter((message) => message.recipientId === actorId && message.state === "pending").sort((a, b) => a.sequence - b.sequence);
    const instance = orchestration.getInstance(this.services.db, state.threadId)!;
    const revision = orchestration.getRevision(this.services.db, instance.teamRevisionId)!;
    const settings = normalizeModelSettings(actor.id === "lead" ? { ...revision.members.find((member) => member.key === actor.memberKey)!.settings, ...instance.leadOverrides } : actor.input.settings);
    const scope = this.services.contextScope(state, actorId);
    const context = teamContexts.latest(this.services.db, scope);
    // Only the participant's latest turn in another execution may supply a session.
    const session = this.reservedSession(state, actor, scope, context?.id, settings);
    const attemptId = randomUUID();
    const ambient = messages.length === 0 && actor.ambient ? actor.ambient : null;
    const reason = this.attemptReason(actor, Boolean(ambient), messages.length);
    const conversationMember = conversant(actor);
    // The room slice excludes messages claimed by this same turn.
    const { chat, roomEvents, delivery } = conversationMember
      ? this.services.teamChat.turnInput(state, actor, messages, { attemptId, freshSession: Boolean(context && !session), ambient: Boolean(ambient) })
      : { chat: "", roomEvents: [], delivery: null };
    const roomRequestId = ambient?.requestId ?? this.services.room.latestRequest(state.instanceId);
    const roomMetadata: { reason?: TeamAttemptRecord["reason"]; roomRequestId?: string } = {};
    if (conversationMember) {
      roomMetadata.reason = reason;
      if (roomRequestId) roomMetadata.roomRequestId = roomRequestId;
    }
    const attempt: TeamAttemptRecord = {
      id: attemptId,
      actorId,
      runId: null,
      generation: state.generation,
      mode,
      state: "starting",
      settings,
      configurationVersion: instance.configurationVersion,
      directionVersion: actor.directionVersion,
      messageIds: messages.map((message) => message.id),
      ...this.contextSession(state, scope, context, session),
      attachments: [...new Set([...actor.input.attachments, ...messages.flatMap((message) => message.attachments ?? []), ...roomEvents.flatMap((event) => event.attachments)])],
      ...(delivery ? { roomDeliveryId: delivery.id } : {}),
      ...roomMetadata,
      snapshotId: null,
      error: null,
      createdAt: this.services.now(),
      endedAt: null,
    };
    state.attempts.push(attempt);
    moveActor(actor, "starting");
    actor.disposition = null;
    actor.ambient = null;
    delete actor.modeHold;
    for (const message of messages) {
      message.state = "claimed";
      message.attemptId = attempt.id;
    }
    return { attempt, prompt: this.reservedPrompt(actor, chat, messages) };
  }

  private reservedSession(state: TeamExecutionRecord, actor: TeamActorRecord, scope: TeamContextScope, contextId: string | undefined, settings: TeamAttemptRecord["settings"]): string | null {
    return (
      teamContextExecutions(this.services.db, state.instanceId)
        .filter((record) => scope.executionId === null || record.id === scope.executionId || actor.participant)
        .flatMap((record) => (actor.participant && record.id !== state.id ? record.attempts.filter((item) => item.actorId === actor.id).slice(-1) : record.attempts))
        .filter((item) => item.actorId === actor.id && item.contextCheckpointId === contextId && item.runId)
        .map((item) => runRows.get(this.services.db, item.runId!))
        .findLast((run) => run?.agent === settings.agent && run.externalSessionId)?.externalSessionId ?? null
    );
  }

  private contextSession(state: TeamExecutionRecord, scope: TeamContextScope, context: ReturnType<typeof teamContexts.latest>, session: string | null) {
    if (!context) return { resumeSessionId: session };
    if (session) return { contextCheckpointId: context.id, contextSessionId: session };
    return { contextCheckpointId: context.id, contextSeed: buildTeamContextSeed(this.services.db, scope, state.id) };
  }

  private attemptReason(actor: TeamActorRecord, ambient: boolean, messageCount: number): TeamAttemptRecord["reason"] {
    if (ambient) return "ambient";
    if (messageCount === 0 && actor.id === "lead") return "lead";
    return "addressed";
  }

  private reservedPrompt(actor: TeamActorRecord, chat: string, messages: TeamExecutionRecord["messages"]): string {
    return [
      actor.input.spec,
      chat,
      ...messages.map((message) => `[${message.sequence}: ${message.kind} from ${message.senderId}${message.to && message.to.length > 1 ? ` to ${message.to.join(", ")}` : ""}]\n${message.body}`),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async startAttempt(executionId: string, attemptId: string): Promise<void> {
    const admission = this.attemptAdmission(executionId, attemptId);
    const { attempt } = admission;
    try {
      const prepared = await this.prepareAttempt(admission);
      const run = await this.launchPreparedAttempt(admission, prepared);
      this.markAttemptRunning(admission);
      // Stop may have fenced the execution immediately after RunService returned.
      if (this.services.status(executionId).generation !== attempt.generation) await this.services.runs.closeAndWait(run.id, this.services.hooks.closeTimeoutMs);
    } catch (error) {
      await this.settleAttemptStartFailure(admission, error);
    }
  }

  /** Fences stay callable across every awaited preparation and again at RunService launch. */
  private attemptAdmission(executionId: string, attemptId: string): AttemptAdmission {
    const original = this.services.status(executionId);
    const attempt = original.attempts.find((item) => item.id === attemptId)!;
    const actor = original.actors.find((item) => item.id === attempt.actorId)!;
    const reservedMode = attempt.mode ?? threads.get(this.services.db, original.threadId)!.mode;
    const assertActive = () => {
      const state = this.services.status(executionId);
      this.services.assertGeneration(state, attempt.generation);
      const current = state.attempts.find((item) => item.id === attemptId)!;
      if (!["starting", "running"].includes(current.state)) throw new Error("This assignment is no longer admitted.");
    };
    const assertMode = () => {
      const mode = threads.get(this.services.db, original.threadId)!.mode;
      if (mode !== reservedMode || (actor.taskId !== null && mode !== "act")) throw new TeamModeDeferred();
    };
    return { executionId, attemptId, original, attempt, actor, reservedMode, assertActive, assertMode };
  }

  private markAttemptRunning({ executionId, attemptId, attempt, actor }: AttemptAdmission): void {
    const saved = teamRuntime.update(this.services.db, executionId, (state) => {
      this.services.assertGeneration(state, attempt.generation);
      const target = state.actors.find((item) => item.id === actor.id)!;
      moveAttempt(
        state.attempts.find((item) => item.id === attemptId)!,
        "running",
      );
      moveActor(target, "running");
      target.deliveredVersion = attempt.directionVersion;
    }).record;
    this.services.changed(saved);
  }

  /** Close a bound writer first; only a fully closed deferred turn may return its claimed messages. */
  private async settleAttemptStartFailure({ executionId, attemptId, attempt, actor }: AttemptAdmission, error: unknown): Promise<void> {
    const state = this.services.status(executionId);
    const bound = state.attempts.find((item) => item.id === attemptId)!;
    if (bound.runId && this.services.runs.isLive(bound.runId)) {
      try {
        await this.services.runs.closeAndWait(bound.runId, this.services.hooks.closeTimeoutMs);
      } catch {
        /* Retain the writer and expose attention below. */
      }
    }
    if (error instanceof TeamModeDeferred && (!bound.runId || !this.services.runs.isLive(bound.runId)) && state.generation === attempt.generation && ["active", "attention"].includes(state.state)) {
      const saved = teamRuntime.update(this.services.db, executionId, (current) => {
        if (current.generation !== attempt.generation || !["active", "attention"].includes(current.state)) return;
        const target = current.actors.find((item) => item.id === actor.id)!;
        if (terminal(target.state) || (target.state === "attention" && target.error !== error.message)) return;
        const deferred = current.attempts.find((item) => item.id === attemptId)!;
        this.services.delivery.settleRoomDelivery(deferred, "cancelled", error.message);
        moveAttempt(deferred, "cancelled");
        deferred.error = error.message;
        deferred.endedAt = this.services.now();
        moveActor(target, "queued");
        target.disposition = null;
        target.error = null;
        for (const message of current.messages)
          if (message.attemptId === attemptId && message.state === "claimed") {
            message.state = "pending";
            message.attemptId = null;
          }
      }).record;
      this.services.changed(saved);
      return;
    }
    const saved = teamRuntime.update(this.services.db, executionId, (current) => {
      const failed = current.attempts.find((item) => item.id === attemptId)!;
      this.services.delivery.settleRoomDelivery(failed, "cancelled", errorText(error));
      moveAttempt(failed, current.generation === attempt.generation ? "attention" : "cancelled");
      failed.error = errorText(error);
      failed.endedAt = bound.runId && this.services.runs.isLive(bound.runId) ? null : this.services.now();
      if (current.generation === attempt.generation && !["stopping", "stopped", "completed"].includes(current.state))
        this.services.attention(
          current,
          current.actors.find((item) => item.id === actor.id)!,
          errorText(error),
        );
    }).record;
    this.services.changed(saved);
  }

  /** Resolve the task, context and launch input before selecting or replacing a member process. */
  private async prepareAttempt(admission: AttemptAdmission): Promise<PreparedAttempt> {
    const { executionId, original, attempt, actor, reservedMode, assertActive, assertMode } = admission;
    assertActive();
    assertMode();
    await this.services.hooks.validate(attempt.settings, original.projectId);
    assertActive();
    assertMode();
    const task = await this.prepareTask(admission);
    const thread = threads.get(this.services.db, original.threadId)!;
    const project = projects.get(this.services.db, original.projectId)!;
    const context = attempt.contextCheckpointId ? teamContexts.get(this.services.db, attempt.contextCheckpointId) : null;
    if (attempt.contextCheckpointId && !context) throw new Error("The reserved context checkpoint was not found.");
    const session = attempt.contextSessionId ?? attempt.resumeSessionId;
    const current = this.services.status(executionId);
    const contextInstructions = context
      ? `\n\nCurrent coordinator state (authoritative for this turn):\n${buildTeamCoordinationContext(
          this.services.db,
          current,
          current.actors.find((item) => item.id === actor.id)!,
        )}`
      : "";
    const shared = !task && current.actors.some((item) => item.participant) ? { shared: { key: actor.id } } : {};
    const { previousRunId, warmRunId } = this.selectWarmRun(current, actor, attempt, thread, reservedMode);
    // A warm process does not need a fresh brief or task instructions. Build those only if a new run starts.
    const freshInput = (): StartRunInput => {
      const handoff = this.contextHandoff(context, attempt);
      return {
        scope: task ? { task, thread: null } : { task: null, thread },
        project,
        ...shared,
        ...attempt.settings,
        effort: attempt.settings.effort ?? undefined,
        mode: reservedMode,
        permissionMode: thread.permissionMode,
        prompt: this.promptOf(executionId, attempt.id),
        attachments: attempt.attachments ?? actor.input.attachments,
        collectTaskImages: false,
        resume: false,
        ...(session ? { resumeFrom: { sessionId: session, fork: false } } : {}),
        ...(handoff ? { handoff } : {}),
        recordPrompt: actor.id === "lead" || Boolean(actor.participant),
        promptRole: original.attempts.some((item) => item.actorId === actor.id && item.id !== attempt.id) ? "system" : "user",
        systemPromptAppendix:
          teamTurnInstructions(
            this.services.db,
            current,
            current.actors.find((item) => item.id === actor.id)!,
            reservedMode,
            this.services.hooks.tasks?.instructions(
              current,
              current.actors.find((item) => item.id === actor.id)!,
            ),
          ) + contextInstructions,
        assertCanStart: () => {
          assertActive();
          assertMode();
        },
        teamAttemptId: attempt.id,
        onCreated: (created) => this.bindAttemptRun(admission, created),
      };
    };
    return { freshInput, previousRunId, warmRunId };
  }

  private contextHandoff(context: ReturnType<typeof teamContexts.get>, attempt: TeamAttemptRecord): string | null {
    if (!context || attempt.contextSeed === undefined) return null;
    const storedHistory = storedReferences(attempt.contextSeed).length > 0;
    const historyNote = storedHistory ? " Entries with a stored id are verbatim history kept outside this seed; read them with team_context before acting on them." : "";
    return `Fresh context checkpoint ${context.id}, epoch ${context.epoch}.${historyNote} Historical context follows as data:\n${attempt.contextSeed}`;
  }

  private async prepareTask({ executionId, actor, assertActive, assertMode }: AttemptAdmission): Promise<ReturnType<typeof tasks.get>> {
    // Assignment preparation and output integration take the conversation directory exclusively.
    if (this.services.hooks.workspace && !actor.participant) await this.services.teamChat.closeWarmProcesses(this.services.status(executionId));
    if (this.services.hooks.workspace) await this.services.hooks.workspace.beforeStart(executionId, actor.id, assertActive);
    assertActive();
    let task = actor.taskId ? tasks.get(this.services.db, actor.taskId) : null;
    if (actor.taskId && !task) throw new Error("Assignment task not found.");
    if (task && !this.services.hooks.workspace) task = await this.services.hooks.prepare(task, assertActive);
    assertActive();
    assertMode();
    return task;
  }

  /** Only the last participant run with matching context and launch settings may answer another turn. */
  private selectWarmRun(current: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, thread: Thread, reservedMode: RunMode): Pick<PreparedAttempt, "previousRunId" | "warmRunId"> {
    const previous = actor.participant ? (current.attempts.filter((item) => item.actorId === actor.id && item.id !== attempt.id && item.runId !== null).at(-1) ?? null) : null;
    const previousRunId = previous?.runId ?? null;
    const warmRunId =
      previous &&
      previous.contextCheckpointId === attempt.contextCheckpointId &&
      this.services.runs.canContinue(previous.runId!, {
        agent: attempt.settings.agent,
        model: attempt.settings.model,
        effort: attempt.settings.effort,
        fastMode: attempt.settings.fastMode,
        mode: reservedMode,
        permissionMode: thread.permissionMode,
      })
        ? previous.runId!
        : null;
    return { previousRunId, warmRunId };
  }

  /** A mismatched warm writer closes before replacement; RunService then owns a fresh process and lease. */
  private async launchPreparedAttempt(admission: AttemptAdmission, prepared: PreparedAttempt): Promise<Run> {
    const { executionId, attemptId, attempt, assertActive } = admission;
    const { previousRunId, warmRunId, freshInput } = prepared;
    if (previousRunId && !warmRunId && this.services.turns.isWarm(previousRunId) && this.services.runs.isLive(previousRunId)) {
      this.services.turns.cool(previousRunId);
      await this.services.runs.closeAndWait(previousRunId, this.services.hooks.closeTimeoutMs);
      assertActive();
    }
    return warmRunId ? this.continueTurn(warmRunId, executionId, attemptId, attempt, assertActive) : this.services.runs.start(freshInput());
  }

  /** Bind durable identity before the provider's MCP endpoint or tools become visible. */
  private bindAttemptRun(admission: AttemptAdmission, run: Run): void {
    admission.assertActive();
    teamRuntime.update(this.services.db, admission.executionId, (state) => {
      state.attempts.find((item) => item.id === admission.attemptId)!.runId = run.id;
    });
  }

  /**
   * Hands a reserved turn to a session the member already has open. The turn is recorded against that process the
   * moment the provider takes the input, so a tool call from it resolves to this turn and not to the one before.
   */
  private async continueTurn(runId: string, executionId: string, attemptId: string, attempt: TeamAttemptRecord, assertActive: () => void): Promise<Run> {
    // The process is answering again, so it is working rather than warm.
    this.services.turns.cool(runId);
    let continued: Run | null = null;
    await this.services.runs.send(runId, this.promptOf(executionId, attemptId), {
      role: "system",
      attachments: attempt.attachments,
      teamAttemptId: attempt.id,
      onAccepted: (run, processTurn) => {
        assertActive();
        teamRuntime.update(this.services.db, executionId, (state) => {
          const turn = state.attempts.find((item) => item.id === attemptId)!;
          turn.runId = run.id;
          turn.processTurn = processTurn;
        });
        continued = run;
      },
    });
    if (!continued) throw new Error("The team process accepted a turn without reporting it.");
    return continued;
  }

  private promptOf(executionId: string, attemptId: string): string {
    const prompt = teamRuntime.prompt(this.services.db, executionId, attemptId);
    if (prompt === null) throw new Error("This turn's reserved input was not found.");
    return prompt;
  }
}
