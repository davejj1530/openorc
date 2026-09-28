import { randomUUID } from "node:crypto";
import { orchestration, projects, taskForwardings, tasks, teamRuntime, teamWorkspaces, threads, runs as runRows } from "@openorc/db";
import {
  TeamDispatchInput,
  teamAttemptDirectionVersion,
  teamAttemptHasUnconfirmedDirection,
  type Task,
  type TeamActorRecord,
  type TeamAttemptRecord,
  type TeamExecutionRecord,
} from "@openorc/protocol";
import type { ReserveTeamTaskInput } from "./team-coordinator.js";
import { assignmentsOf, errorText, hash, terminal, type AssignmentCore } from "./team-core.js";
import { moveActor, moveExecution } from "./team-states.js";

/**
 * Delegated work down the saved hierarchy: reserving an assignment for a direct report, replaying a request by its
 * key, and a manager's wait and completion. A saved task is reassigned only after its previous subtree fully closed.
 */
export class TeamAssignments {
  constructor(private readonly core: AssignmentCore) {}

  private unfinishedWork(record: TeamExecutionRecord, actor: TeamActorRecord): boolean {
    return record.actors.some((child) => child.parentId === actor.id && !child.participant && child.state !== "completed") || Boolean(this.core.hooks.tasks?.hasPendingWork?.(record, actor));
  }

  planningHold(record: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord): boolean {
    return actor.id === "lead" && (attempt.mode ?? (attempt.runId ? runRows.get(this.core.db, attempt.runId)?.mode : undefined)) === "plan" && this.unfinishedWork(record, actor);
  }

  /** A lead's planning reply keeps unfinished execution work until Act resumes it, or new direction does. */
  holdForPlan(state: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, fresh: boolean): boolean {
    if (!this.planningHold(state, actor, attempt)) return false;
    const resume = threads.get(this.core.db, state.threadId)?.mode === "act" || !fresh;
    moveActor(actor, resume ? "queued" : "waiting");
    actor.disposition = null;
    if (resume) delete actor.modeHold;
    else actor.modeHold = "plan";
    return true;
  }

  /**
   * Settles a lead's or an assignment's turn from the outcome it recorded. A completion reports its result to its
   * manager once every child finished and the task hooks accept it; a wait yields; newer direction requeues it; a lead
   * that ran alone completes with its reply. A turn that ended without saying what it did needs review.
   */
  settleTurn(
    state: TeamExecutionRecord,
    actor: TeamActorRecord,
    attempt: TeamAttemptRecord,
    turn: { runId: string; snapshotId: string | null; fresh: boolean; planningLead: boolean; completionError: string | null },
  ): void {
    const disposition = actor.disposition;
    const completing = disposition?.kind === "complete" && disposition.version === teamAttemptDirectionVersion(attempt);
    const leadAlone = actor.id === "lead" && (assignmentsOf(state).length === 1 || turn.planningLead);
    if (turn.fresh && (completing || (leadAlone && disposition === null))) {
      let completionError = turn.completionError;
      try {
        completionError ??= this.core.hooks.tasks?.completionReason(state, actor, attempt) ?? null;
      } catch (error) {
        completionError = `Task completion needs attention: ${errorText(error)}`;
      }
      if (completionError) {
        this.core.attention(state, actor, completionError);
        return;
      }
    }
    if (turn.fresh && completing) {
      this.completeAssignment(state, actor, attempt, { result: disposition.result, snapshotId: turn.snapshotId });
    } else if (disposition?.kind === "wait") moveActor(actor, "waiting");
    else if (!turn.fresh) this.retryWithNewDirection(actor);
    else if (leadAlone) this.completeSoloLead(actor, turn);
    else this.core.attention(state, actor, "The agent ended its turn without team_wait or team_complete. Review its result before retrying.");
  }

  /** Completion publishes one result only after every child is finished. */
  private completeAssignment(state: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, outcome: { result: string | null; snapshotId: string | null }): void {
    if (state.actors.some((child) => child.parentId === actor.id && !child.participant && child.state !== "completed")) {
      this.core.attention(state, actor, "Assignments remain unresolved.");
      return;
    }
    moveActor(actor, "completed");
    actor.result = outcome.result;
    actor.snapshotId = outcome.snapshotId;
    if (actor.parentId) {
      try {
        this.core.delivery.enqueueMessage(state, {
          senderId: actor.id,
          recipientId: actor.parentId,
          kind: "result",
          body: `${actor.input.title}\n${actor.result}\nSnapshot: ${outcome.snapshotId}`,
          dedupeKey: `result:${actor.id}:${attempt.id}`,
        });
      } catch (error) {
        moveActor(actor, "attention");
        actor.error = errorText(error);
        moveExecution(state, "attention");
        state.error = actor.error;
      }
    }
  }

  /** New direction supersedes the old disposition without spending an explicit retry. */
  private retryWithNewDirection(actor: TeamActorRecord): void {
    moveActor(actor, "queued");
    actor.disposition = null;
  }

  private completeSoloLead(actor: TeamActorRecord, turn: { runId: string; snapshotId: string | null }): void {
    moveActor(actor, "completed");
    actor.result = runRows.get(this.core.db, turn.runId)?.resultText ?? "";
    actor.snapshotId = turn.snapshotId;
  }

  dispatch(runId: string, raw: TeamDispatchInput): TeamActorRecord {
    const input = TeamDispatchInput.parse(raw);
    return this.reserveAssignment(runId, input);
  }

  dispatchReplay(runId: string, raw: TeamDispatchInput): TeamActorRecord | null {
    const input = TeamDispatchInput.parse(raw);
    const caller = this.core.actorFor(runId);
    return this.assignmentReplay(caller.record, caller.actor.id, input);
  }

  private assignmentReplay(record: TeamExecutionRecord, parentId: string, input: TeamDispatchInput, taskId?: string): TeamActorRecord | null {
    const previous = record.actors.find((actor) => actor.parentId === parentId && actor.requestKey === input.requestKey);
    if (!previous) return null;
    if (previous.requestHash !== hash(taskId ? { taskId, ...input } : input)) throw new Error("This request key already identifies different work.");
    return previous;
  }

  reserveTask(runId: string, raw: ReserveTeamTaskInput): TeamActorRecord {
    if (!raw.taskId?.trim()) throw new Error("Choose an existing saved task.");
    const input = TeamDispatchInput.parse({ ...raw.input, memberKey: raw.memberKey, requestKey: raw.requestKey, dependencies: raw.dependencies ?? [] });
    return this.reserveAssignment(runId, input, raw.taskId);
  }

  /** Reservation captures accepted input without replacing the editable task document. */
  private reserveAssignment(runId: string, input: TeamDispatchInput, taskId?: string): TeamActorRecord {
    if (taskId && taskForwardings.source(this.core.db, taskId)) throw new Error("This task has been forwarded to an independent agent.");
    const caller = this.core.actorFor(runId);
    const replay = this.assignmentReplay(caller.record, caller.actor.id, input, taskId);
    if (replay) return replay;
    const thread = threads.get(this.core.db, caller.record.threadId)!;
    if (caller.run.mode !== "act" || thread.mode !== "act") throw new Error("Delegating execution requires Act mode. Capture backlog work without starting it.");
    const instance = orchestration.getInstance(this.core.db, thread.id)!;
    const revision = orchestration.getRevision(this.core.db, instance.teamRevisionId)!;
    const member = revision.members.find((item) => item.key === input.memberKey);
    if (!member || member.managerKey !== caller.actor.memberKey) throw new Error("Delegate only to one of your direct reports.");
    const fingerprint = hash(taskId ? { taskId, ...input } : input);
    const { record, value } = teamRuntime.update(this.core.db, caller.record.id, (state) => {
      this.core.assertGeneration(state, caller.binding.generation);
      const previous = this.assignmentReplay(state, caller.actor.id, input, taskId);
      if (previous) return previous;
      if (assignmentsOf(state).length - 1 >= state.limits.maxAssignments) throw new Error("This execution reached its assignment limit.");
      if (state.actors.some((actor) => !actor.participant && actor.memberKey === member.key && !terminal(actor.state))) throw new Error("This member already has an active assignment.");
      if (new Set(input.dependencies).size !== input.dependencies.length) throw new Error("Dependencies must be unique.");
      for (const id of input.dependencies) {
        const dependency = state.actors.find((actor) => actor.id === id);
        if (!dependency || dependency.parentId !== caller.actor.id) throw new Error("Dependencies must belong to this execution and the same requesting manager.");
      }
      let task: Task;
      if (taskId) {
        const saved = tasks.get(this.core.db, taskId);
        if (!saved || saved.projectId !== state.projectId || saved.threadId !== state.threadId || saved.parentTaskId !== caller.actor.taskId)
          throw new Error("The saved task must belong to this team's thread and its requesting manager's task.");
        this.assertTaskReleased(taskId);
        task = saved;
      } else
        task = tasks.insert(this.core.db, {
          projectId: state.projectId,
          threadId: state.threadId,
          title: input.title,
          spec: input.spec,
          priority: "none",
          labels: [],
          workspaceMode: "worktree",
          baseRef: thread.branch ?? projects.get(this.core.db, state.projectId)!.defaultBranch,
          parentTaskId: caller.actor.taskId,
          origin: "agent",
        });
      const actor: TeamActorRecord = {
        id: randomUUID(),
        memberKey: member.key,
        taskId: task.id,
        parentId: caller.actor.id,
        requestKey: input.requestKey,
        requestHash: fingerprint,
        dependencies: input.dependencies,
        dispatchedBy: caller.attempt.id,
        input: { title: input.title, spec: input.spec, attachments: input.attachments, responsibility: member.responsibility, settings: member.settings },
        state: "queued",
        retries: 0,
        directionVersion: 0,
        deliveredVersion: 0,
        disposition: null,
        result: null,
        snapshotId: null,
        error: null,
      };
      state.actors.push(actor);
      state.actors.find((item) => item.id === caller.actor.id)!.disposition = null;
      return actor;
    });
    this.core.changed(record);
    this.core.scheduler.schedule();
    return value;
  }

  private assertTaskReleased(taskId: string): void {
    if (this.core.runs.liveRunForTask(taskId)) throw new Error("The saved task's previous provider process has not finished closing.");
    for (const binding of teamRuntime.assignmentsForTask(this.core.db, taskId)) {
      const previous = this.core.status(binding.executionId);
      const subtree = new Set([binding.actorId]);
      for (let size = 0; size !== subtree.size;) {
        size = subtree.size;
        for (const child of previous.actors) if (child.parentId && subtree.has(child.parentId)) subtree.add(child.id);
      }
      if (this.core.stopping.has(previous.id) || previous.actors.some((actor) => subtree.has(actor.id) && !terminal(actor.state)))
        throw new Error("The saved task's previous assignment or subtree has not finished closing.");
      if (previous.attempts.some((attempt) => subtree.has(attempt.actorId) && this.core.turns.writing(attempt)))
        throw new Error("Wait for the saved task's previous preparation and writers to finish.");
      if (
        teamWorkspaces
          .publications(this.core.db, previous.id)
          .some((receipt) => receipt.state !== "applied" && (subtree.has(receipt.sourceActorId) || subtree.has(receipt.targetActorId) || receipt.includedActorIds.some((id) => subtree.has(id))))
      )
        throw new Error("The saved task's retained output needs integration recovery before another assignment.");
      this.core.hooks.workspace?.assertStopped?.(previous.id);
    }
  }

  wait(runId: string, input: { assignmentIds?: string[] } = {}): void {
    const caller = this.core.actorFor(runId);
    if (teamAttemptHasUnconfirmedDirection(caller.attempt)) throw new Error("Wait for live direction to be confirmed before recording this turn's outcome.");
    const waitFor = input.assignmentIds ?? caller.record.actors.filter((actor) => actor.parentId === caller.actor.id && !actor.participant && !terminal(actor.state)).map((actor) => actor.id);
    if (new Set(waitFor).size !== waitFor.length || waitFor.some((id) => !caller.record.actors.some((actor) => actor.id === id && actor.parentId === caller.actor.id)))
      throw new Error("Wait only for your own assignments; a wait cannot include itself or another subtree.");
    const { record } = teamRuntime.update(this.core.db, caller.record.id, (state) => {
      const actor = state.actors.find((item) => item.id === caller.actor.id)!;
      actor.disposition = { kind: "wait", version: teamAttemptDirectionVersion(caller.attempt), waitFor, result: null };
    });
    this.core.changed(record);
  }

  complete(runId: string, input: { result: string }): void {
    const caller = this.core.actorFor(runId);
    if (!input.result.trim() || input.result.length > 100_000) throw new Error("Completion needs a bounded result summary.");
    const { record } = teamRuntime.update(this.core.db, caller.record.id, (state) => {
      const actor = state.actors.find((item) => item.id === caller.actor.id)!;
      if (this.planningHold(state, actor, caller.attempt))
        throw new Error("Plan mode preserves unfinished execution work. End your planning reply or wait; return to Act to complete the retained assignments.");
      if (state.actors.some((child) => child.parentId === actor.id && !child.participant && child.state !== "completed"))
        throw new Error("Required assignments are unresolved. Wait for or recover them before completing.");
      if (this.core.delivery.hasNewDirection(state, caller.attempt)) throw new Error("New direction arrived during this turn. Address it before completing.");
      const reason =
        this.core.hooks.tasks?.completionReason(
          state,
          actor,
          state.attempts.find((attempt) => attempt.id === caller.attempt.id)!,
        ) ?? null;
      if (reason) throw new Error(reason);
      actor.disposition = { kind: "complete", version: teamAttemptDirectionVersion(caller.attempt), waitFor: [], result: input.result };
    });
    this.core.changed(record);
  }
}
