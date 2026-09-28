import { admissionReviewBatch } from "./team-task-review-batch.js";
import { routedAdmissionState, capturedTaskMessage } from "./team-task-presentation.js";
import { createHash, randomUUID } from "node:crypto";
import {
  audit,
  checkpoints,
  comments,
  orchestration,
  runs,
  snapshots,
  taskForwardings,
  tasks,
  teamDeletedThreads,
  teamRuntime,
  teamTaskCompletions,
  teamTasks,
  teamWorkspaces,
  threads,
  type Db,
} from "@openorc/db";
import {
  TaskPriority,
  TeamTaskInputSnapshot,
  type Task,
  type TeamActionAvailability,
  type TeamActorRecord,
  type TeamAttemptRecord,
  type TeamExecutionRecord,
  type TeamTaskActionResult,
  type TeamTaskAdmission,
  type TeamTaskAdmissionView,
  type TeamTaskIntent,
  type TeamTaskView,
} from "@openorc/protocol";
import { z } from "zod";
import type { TeamCoordinator } from "./team-coordinator.js";
import type { ReviewService } from "./review.js";
import type { RunService, TurnSettledOutcome } from "./runs.js";
import { terminalAdmissionState } from "./team-task-admission-state.js";

const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const terminal = (state: string) => state === "completed" || state === "cancelled";
const done = (state: TeamTaskAdmissionView["state"]) => state === "completed" || state === "stopped";

const captureInput = z.object({
  title: z.string().trim().min(1).max(300),
  spec: z.string().min(1).max(100_000),
  priority: TaskPriority.default("none"),
  labels: z.array(z.string().min(1).max(60)).max(20).default([]),
  execution: z.enum(["backlog", "delegate"]).default("backlog"),
  memberKey: z.string().min(1).optional(),
  requestKey: z.string().min(1).max(200).optional(),
  dependencies: z.array(z.string().min(1)).max(100).default([]),
  dependencyTaskIds: z.array(z.string().min(1)).max(100).default([]),
});
export type CaptureTeamTaskInput = z.input<typeof captureInput>;

interface TaskControls {
  images(spec: string): Promise<string[]>;
  review: ReviewService;
  runs: RunService;
  enabled(): boolean;
  /** Assignment publication availability, shared with the review service. */
  exportAvailability?(taskId: string): (TeamActionAvailability & { branch: string }) | null;
  /** Final deletion of a hidden owner through one of its saved tasks. */
  deleteOwner?(threadId: string): TeamTaskView["deleteOwner"];
}

/** Historical completion is useful only when the accepted output reached this manager's input. */
function inheritedPrerequisite(db: Db, current: TeamExecutionRecord, caller: TeamActorRecord, source: { executionId: string; actorId: string }): boolean {
  const executions = new Map((db.stmt("SELECT id FROM team_executions WHERE instance_id = ?").all(current.instanceId) as { id: string }[]).map((row) => [row.id, teamRuntime.get(db, row.id)!]));
  const original = executions.get(source.executionId);
  const actor = original?.actors.find((item) => item.id === source.actorId);
  const output = teamWorkspaces.get(db, source.executionId, source.actorId);
  if (actor?.state !== "completed" || output?.state !== "ready" || output.setupState !== "completed" || !output.outputTree) return false;
  const publications = teamWorkspaces.publications(db).filter((receipt) => executions.has(receipt.executionId));
  if (
    actor.parentId &&
    !publications.some(
      (receipt) =>
        receipt.executionId === source.executionId &&
        receipt.sourceActorId === actor.id &&
        receipt.targetActorId === actor.parentId &&
        receipt.outputTree === output.outputTree &&
        receipt.state === "applied",
    )
  )
    return false;
  const workspaces = teamWorkspaces.list(db).filter((workspace) => executions.has(workspace.executionId) && workspace.state === "ready" && workspace.setupState === "completed");
  const key = (executionId: string, actorId: string) => JSON.stringify([executionId, actorId]);
  const accepted = new Map<string, Set<string>>();
  let changed = false;
  const retain = (identity: string, tree: string | null) => {
    if (!tree) return;
    const trees = accepted.get(identity) ?? new Set<string>();
    if (trees.has(tree)) return;
    trees.add(tree);
    accepted.set(identity, trees);
    changed = true;
  };
  retain(key(source.executionId, source.actorId), output.outputTree);
  while (changed) {
    changed = false;
    for (const workspace of workspaces) {
      const identity = key(workspace.executionId, workspace.actorId);
      const trees = accepted.get(identity);
      const execution = executions.get(workspace.executionId)!;
      const actor = execution.actors.find((item) => item.id === workspace.actorId)!;
      // A completed manager's output is its combined accepted subtree. An
      // active manager may instead carry inherited input through closed turns.
      if (trees?.size && actor.state === "completed") retain(identity, workspace.outputTree);
      if (workspace.preparedTree && trees?.has(workspace.preparedTree)) {
        for (const attempt of execution.attempts.filter(
          (item) => item.actorId === actor.id && item.state === "closed" && item.endedAt !== null && item.error === null && item.snapshotId && item.runId,
        )) {
          const snapshot = actor.id === "lead" ? checkpoints.get(db, attempt.snapshotId!) : snapshots.get(db, attempt.snapshotId!);
          if (snapshot?.runId === attempt.runId && runs.get(db, attempt.runId!)?.state === "success") retain(identity, snapshot.treeSha);
        }
      }
      for (const parent of workspaces)
        if (parent.path === workspace.source.rootPath && accepted.get(key(parent.executionId, parent.actorId))?.has(workspace.source.treeSha) && workspace.preparedTree === workspace.source.treeSha)
          retain(identity, workspace.preparedTree);
    }
    for (const receipt of publications)
      if (receipt.state === "applied" && receipt.afterTree) {
        const target = key(receipt.executionId, receipt.targetActorId);
        if (accepted.get(key(receipt.executionId, receipt.sourceActorId))?.has(receipt.outputTree) || accepted.get(target)?.has(receipt.before.treeSha)) retain(target, receipt.afterTree);
      }
  }
  return Boolean(accepted.get(key(current.id, caller.id))?.size);
}

/** Current siblings remain scheduler dependencies; historical results require input provenance. */
export function teamTaskDependencies(db: Db, record: TeamExecutionRecord, caller: TeamActorRecord, intent: TeamTaskIntent): string[] {
  const dependencies: string[] = [];
  for (const taskId of intent.dependencyTaskIds) {
    const bindings = teamRuntime.assignmentsForTask(db, taskId);
    const current = bindings.findLast((binding) => binding.executionId === record.id);
    const actor = current ? record.actors.find((item) => item.id === current.actorId)! : null;
    const admissions = teamTasks.admissions(db, taskId);
    let completedLead: { executionId: string; actorId: string } | null = null;
    for (const admission of admissions) {
      const route = teamTasks.routes(db, admission.id).at(-1);
      const completion = teamTaskCompletions.get(db, admission.id);
      if (completion) {
        completedLead = completion;
        continue;
      }
      const execution = route ? teamRuntime.get(db, route.executionId) : null;
      const owner = execution?.actors.find((item) => item.id === route?.actorId);
      if (execution?.state === "stopped" || owner?.state === "cancelled" || execution?.messages.find((item) => item.id === route?.messageId)?.state === "cancelled") continue;
      if (route?.role === "assignee" && owner?.id !== "lead" && owner?.state === "completed") {
        completedLead = null;
        continue;
      }
      if (route?.executionId === record.id && route.role === "assignee" && owner?.id === actor?.id) {
        completedLead = null;
        continue;
      }
      throw new Error(`Prerequisite task ${taskId} has unfinished accepted work. Route or finish that request before assigning this task.`);
    }
    if (completedLead?.executionId === record.id && completedLead.actorId === caller.id) continue;
    if (actor) {
      if (actor.parentId !== caller.id) throw new Error("A prerequisite is assigned under another manager.");
      if (actor.state === "cancelled") throw new Error(`Start prerequisite task ${taskId} before assigning this request.`);
      const output = teamWorkspaces.get(db, record.id, actor.id);
      if (
        actor.state === "completed" &&
        output?.outputTree &&
        teamWorkspaces
          .publications(db, record.id)
          .some((receipt) => receipt.sourceActorId === actor.id && receipt.targetActorId === caller.id && receipt.outputTree === output.outputTree && receipt.state === "applied")
      )
        continue;
      dependencies.push(actor.id);
      continue;
    }
    const source = completedLead ?? bindings.at(-1);
    if (!source) throw new Error(`Start prerequisite task ${taskId} before assigning this request.`);
    if (!inheritedPrerequisite(db, record, caller, source))
      throw new Error(`Prerequisite task ${taskId} has no proven accepted output in this manager's workspace. Recover its integration or rerun the prerequisite here before assigning this task.`);
  }
  return dependencies;
}

/** Task documents and execution requests have separate lifetimes. Capture never launches work. */
export class TeamTaskService {
  constructor(
    private readonly db: Db,
    private readonly authority: TeamCoordinator,
    private readonly invalidate: (keys: string[]) => void,
    private readonly controls: TaskControls,
  ) {}

  private scope(taskId: string) {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    const thread = task.threadId ? threads.get(this.db, task.threadId) : null;
    const instance = thread ? orchestration.getInstance(this.db, thread.id) : null;
    if (!thread || !instance) throw new Error("This task does not belong to a saved team.");
    const revision = orchestration.getRevision(this.db, instance.teamRevisionId);
    if (!revision || task.projectId !== revision.projectId || thread.projectId !== task.projectId) throw new Error("Task ownership does not match its team.");
    return { task, thread, instance, revision };
  }

  /** Older ordinary captures and immediate assignments gain intent only at admission. */
  private describeIntent(taskId: string): TeamTaskIntent {
    const stored = teamTasks.intent(this.db, taskId);
    if (stored) return stored;
    const { task, instance, revision } = this.scope(taskId);
    const binding = teamRuntime.assignmentsForTask(this.db, taskId).at(-1);
    const record = binding ? this.authority.status(binding.executionId) : null;
    const actor = record?.actors.find((item) => item.id === binding?.actorId);
    const parent = record?.actors.find((item) => item.id === actor?.parentId);
    const parentBinding = task.parentTaskId ? teamRuntime.assignmentsForTask(this.db, task.parentTaskId).at(-1) : null;
    const parentActor = parentBinding ? this.authority.status(parentBinding.executionId).actors.find((item) => item.id === parentBinding.actorId) : null;
    const managerKey =
      parent?.memberKey ?? parentActor?.memberKey ?? (task.parentTaskId ? teamTasks.intent(this.db, task.parentTaskId)?.memberKey : revision.members.find((item) => item.managerKey === null)?.key);
    if (!managerKey) throw new Error("This task's manager history could not be found.");
    return {
      taskId,
      instanceId: instance.id,
      teamRevisionId: revision.id,
      managerKey,
      memberKey: actor?.memberKey ?? null,
      parentTaskId: task.parentTaskId,
      dependencyTaskIds: actor?.dependencies.map((id) => record!.actors.find((item) => item.id === id)!.taskId!) ?? [],
      origin: parent && record ? { executionId: record.id, actorId: parent.id } : null,
      capture: null,
      createdAt: task.createdAt,
    };
  }

  private history(instanceId: string): TeamTaskAdmission[] {
    return teamTasks.intents(this.db, instanceId).flatMap((intent) => teamTasks.admissions(this.db, intent.taskId));
  }

  private projectAdmission(admission: TeamTaskAdmission): TeamTaskAdmissionView {
    const route = teamTasks.routes(this.db, admission.id).at(-1);
    const record = route ? this.authority.status(route.executionId) : null;
    const actor = record?.actors.find((item) => item.id === route?.actorId);
    const message = record?.messages.find((item) => item.id === route?.messageId);
    const completion = teamTaskCompletions.get(this.db, admission.id);
    const terminalState = terminalAdmissionState({ completed: Boolean(completion), route, actor, executionState: record?.state, messageState: message?.state });
    let state: TeamTaskAdmissionView["state"] = terminalState ?? "queued";
    if (!terminalState && (record?.state === "attention" || actor?.state === "attention")) state = "attention";
    else if (!terminalState && route && (route.messageId === null || message?.state === "claimed" || message?.state === "delivered")) {
      state = routedAdmissionState(actor);
    }
    const batch = admission.reviewBatchId ? teamTasks.batch(this.db, admission.reviewBatchId) : null;
    const retried = teamTasks.admissions(this.db, admission.taskId).some((item) => item.sourceAdmissionId === admission.id);
    return {
      id: admission.id,
      requestKey: admission.requestKey,
      kind: admission.kind,
      createdAt: admission.createdAt,
      state,
      executionId: route?.executionId ?? null,
      actorId: route?.actorId ?? null,
      memberKey: actor?.memberKey ?? null,
      role: route?.role ?? null,
      result: completion?.result ?? (state === "completed" ? (actor?.result ?? null) : null),
      error: state === "attention" || state === "stopped" ? (actor?.error ?? record?.error ?? null) : null,
      reviewBatch: batch ? { id: batch.id, comments: batch.comments } : null,
      retry:
        state === "stopped" && !retried
          ? this.availability(admission.taskId, "retry")
          : {
              allowed: false,
              reason: retried
                ? "This request was already retried. Use the latest request's recovery controls."
                : "Stop this request before admitting its retained input again. Use the assignment's Retry for an interrupted run.",
            },
    };
  }

  private availability(taskId: string, kind: "start" | "review" | "retry"): TeamActionAvailability {
    try {
      if (taskForwardings.source(this.db, taskId)) throw new Error("This task has been forwarded to an independent agent. Open the forwarded task to continue.");
      const { task, thread } = this.scope(taskId);
      const active = teamRuntime.activeForThread(this.db, thread.id);
      if (thread.archivedAt !== null || task.status === "archived") throw new Error("Restore this task and its team conversation before starting work.");
      if (thread.mode !== "act") throw new Error("Switch the team conversation to Act before starting this task.");
      if (!active && !this.controls.enabled()) throw new Error("Enable the team execution preview in Settings before starting work.");
      if (active?.state === "stopping") throw new Error("Wait for the team to finish stopping.");
      if (kind === "start" && active && this.activeActor(taskId, active)) throw new Error("This task already has an active assignment. Send feedback instead.");
      if ((kind === "start" || kind === "retry") && teamTasks.admissions(this.db, taskId).some((item) => !done(this.projectAdmissionWithoutRetry(item))))
        throw new Error("This task already has accepted work. Send feedback or use its recovery controls.");
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // Avoid availability → projection → retry availability recursion.
  private projectAdmissionWithoutRetry(admission: TeamTaskAdmission): TeamTaskAdmissionView["state"] {
    if (teamTaskCompletions.get(this.db, admission.id)) return "completed";
    const route = teamTasks.routes(this.db, admission.id).at(-1);
    if (!route) return "queued";
    const record = this.authority.status(route.executionId);
    const actor = record.actors.find((item) => item.id === route.actorId)!;
    const message = record.messages.find((item) => item.id === route.messageId);
    return terminalAdmissionState({ completed: false, route, actor, executionState: record.state, messageState: message?.state }) ?? "queued";
  }

  state(taskId: string): TeamTaskView | null {
    const task = tasks.get(this.db, taskId);
    // A task deleted with its hidden owner reads as ordinary absence, like a deleted conversation's runtime.
    if (!task) return null;
    if (!task.threadId || !orchestration.getInstance(this.db, task.threadId)) return null;
    const { thread, instance, revision } = this.scope(taskId);
    const intent = this.describeIntent(taskId);
    const admissions = teamTasks.admissions(this.db, taskId).map((item) => this.projectAdmission(item));
    const assignments = teamRuntime.assignmentsForTask(this.db, taskId).map((binding) => {
      const record = this.authority.status(binding.executionId);
      const actor = record.actors.find((item) => item.id === binding.actorId)!;
      return {
        executionId: record.id,
        actorId: actor.id,
        memberKey: actor.memberKey,
        state: actor.state,
        runIds: record.attempts.filter((item) => item.actorId === actor.id).flatMap((item) => (item.runId ? [item.runId] : [])),
        result: actor.result,
      };
    });
    const leadAdmissions = admissions.filter((admission) => admission.actorId === "lead" && admission.role === "assignee" && admission.executionId);
    for (const executionId of new Set(leadAdmissions.map((admission) => admission.executionId!))) {
      const related = leadAdmissions.filter((admission) => admission.executionId === executionId);
      const record = this.authority.status(executionId);
      const actor = record.actors[0]!;
      const attempts = record.attempts.filter((item) => item.actorId === "lead");
      const selected = new Set<string>();
      for (const admission of related) {
        const route = teamTasks.routes(this.db, admission.id).at(-1)!;
        const first = route.messageId === null ? 0 : attempts.findIndex((attempt) => attempt.messageIds.includes(route.messageId!));
        if (first < 0) continue; // The lead has not received this request yet.
        const receipt = teamTaskCompletions.get(this.db, admission.id);
        const last = receipt ? attempts.findIndex((attempt) => attempt.id === receipt.attemptId) : attempts.length - 1;
        for (const attempt of attempts.slice(first, last + 1)) if (attempt.runId) selected.add(attempt.runId);
      }
      const completed = related.every((admission) => admission.state === "completed");
      assignments.push({
        executionId,
        actorId: actor.id,
        memberKey: actor.memberKey,
        state: completed ? "completed" : actor.state,
        runIds: attempts.flatMap((attempt) => (attempt.runId && selected.has(attempt.runId) ? [attempt.runId] : [])),
        result: related.at(-1)?.result ?? null,
      });
    }
    const assignmentTime = (assignment: (typeof assignments)[number]) => {
      const record = this.authority.status(assignment.executionId);
      const firstRun = record.attempts.find((item) => assignment.runIds.includes(item.runId ?? ""));
      if (firstRun) return firstRun.createdAt;
      const route = admissions
        .filter((item) => item.executionId === assignment.executionId && item.actorId === assignment.actorId)
        .flatMap((item) => teamTasks.routes(this.db, item.id))
        .filter((item) => item.executionId === assignment.executionId && item.actorId === assignment.actorId)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      return route?.createdAt ?? record.createdAt;
    };
    assignments.sort((a, b) => assignmentTime(a) - assignmentTime(b));
    const ownerDeletedAt = teamDeletedThreads.get(this.db, thread.id)?.deletedAt ?? null;
    const deleteOwner = ownerDeletedAt === null ? undefined : this.controls.deleteOwner?.(thread.id);
    return {
      taskId,
      threadId: thread.id,
      teamName: revision.name,
      ownerDeletedAt,
      ...(deleteOwner ? { deleteOwner } : {}),
      members: revision.members.map((member) => (member.managerKey === null ? { ...member, settings: { ...member.settings, ...instance.leadOverrides } } : member)),
      policy: this.controls.runs.threadPermissions(thread.id),
      managerKey: intent.managerKey,
      memberKey: intent.memberKey,
      dependencyTaskIds: intent.dependencyTaskIds,
      start: this.availability(taskId, "start"),
      review: this.availability(taskId, "review"),
      ...(() => {
        const exported = this.controls.exportAvailability?.(taskId);
        return exported ? { export: exported } : {};
      })(),
      admissions,
      claimedCommentIds: [...new Set(admissions.flatMap((item) => item.reviewBatch?.comments.map((comment) => comment.id) ?? []))],
      assignments,
      working: teamWorking(assignments, admissions),
    };
  }

  /** Whether the team still owns the task's status; a finished task is the user's to review and close. */
  working(taskId: string): boolean {
    return this.state(taskId)?.working ?? false;
  }

  start(input: { taskId: string; requestKey: string }): Promise<TeamTaskActionResult> {
    return this.accept({ ...input, kind: "start" });
  }
  sendReview(input: { taskId: string; requestKey: string; commentIds: string[] }): Promise<TeamTaskActionResult> {
    return this.accept({ ...input, kind: "review" });
  }
  retry(input: { taskId: string; admissionId: string; requestKey: string }): Promise<TeamTaskActionResult> {
    const previous = teamTasks.admission(this.db, input.admissionId);
    if (!previous || previous.taskId !== input.taskId) throw new Error("The retained request belongs to another task.");
    return this.accept({ taskId: input.taskId, requestKey: input.requestKey, kind: previous.kind, sourceAdmissionId: previous.id });
  }

  private activeActor(taskId: string, execution: TeamExecutionRecord) {
    const binding = teamRuntime
      .assignmentsForTask(this.db, taskId)
      .findLast((item) => item.executionId === execution.id && !terminal(execution.actors.find((actor) => actor.id === item.actorId)!.state));
    if (binding) return execution.actors.find((actor) => actor.id === binding.actorId)!;
    const lead = execution.actors[0]!;
    if (
      !terminal(lead.state) &&
      teamTasks.admissions(this.db, taskId).some(
        (item) =>
          !done(this.projectAdmissionWithoutRetry(item)) &&
          (() => {
            const route = teamTasks.routes(this.db, item.id).at(-1);
            return route?.executionId === execution.id && route.actorId === "lead" && route.role === "assignee";
          })(),
      )
    )
      return lead;
    return null;
  }

  private source(taskId: string): TeamTaskAdmission["source"] {
    const { thread } = this.scope(taskId);
    const active = teamRuntime.activeForThread(this.db, thread.id);
    const actor = active && this.activeActor(taskId, active);
    if (actor && active) return { executionId: active.id, actorId: actor.id, snapshotId: actor.id === "lead" ? null : actor.snapshotId };
    const snapshot = snapshots.latestForTask(this.db, taskId);
    const run = snapshot?.runId ? teamRuntime.binding(this.db, snapshot.runId) : null;
    if (run) return { executionId: run.executionId, actorId: run.actorId, snapshotId: snapshot!.id };
    const binding = teamRuntime.assignmentsForTask(this.db, taskId).at(-1);
    return binding ? { executionId: binding.executionId, actorId: binding.actorId, snapshotId: null } : null;
  }

  private prompt(admission: TeamTaskAdmission, role: "manager" | "assignee" = "manager"): string {
    const intent = teamTasks.intent(this.db, admission.taskId)!;
    const batch = admission.reviewBatchId ? teamTasks.batch(this.db, admission.reviewBatchId) : null;
    return [
      `Required task request ${admission.id}. Task: ${admission.taskId}.`,
      `Title: ${admission.input.title}`,
      `Saved manager: ${intent.managerKey}. Intended member: ${intent.memberKey ?? "choose a direct report or handle it as lead"}.`,
      `Task dependencies: ${intent.dependencyTaskIds.join(", ") || "none"}.`,
      role === "manager"
        ? "Use task_start with this task ID and admission_id to route or claim this retained request. Start missing prerequisite tasks first. Do not create a replacement task."
        : "You are assigned this accepted request. Implement it under the original task ID. An assigned worker uses team_complete; the lead uses task_complete with this task ID and admission_id. Then end the turn successfully to capture output.",
      "Accepted task document (later edits do not change this request):",
      admission.input.spec,
      ...(batch
        ? [
            "Selected feedback, with retained source versions:",
            ...batch.comments.map((comment) => `${comment.path}:${comment.line ?? "file"}, side ${comment.side ?? "file"}, snapshot ${comment.snapshotId ?? "unanchored"}`),
            batch.prompt,
          ]
        : []),
    ].join("\n\n");
  }

  private async accept(input: { taskId: string; requestKey: string; kind: "start" | "review"; commentIds?: string[]; sourceAdmissionId?: string; runId?: string }): Promise<TeamTaskActionResult> {
    if (!input.requestKey.trim() || input.requestKey.length > 200) throw new Error("A bounded request key is required.");
    const initial = this.scope(input.taskId);
    const payloadHash = hash({ taskId: input.taskId, kind: input.kind, commentIds: input.commentIds ?? [], sourceAdmissionId: input.sourceAdmissionId ?? null });
    const replay = () => {
      const existing = teamTasks.findRequest(this.db, initial.instance.id, input.requestKey);
      if (existing && (existing.taskId !== input.taskId || existing.payloadHash !== payloadHash)) throw new Error("This request key already identifies different task input or selected comments.");
      return existing;
    };
    const retained = replay();
    if (retained) return { admissionId: retained.id, task: this.state(input.taskId)! };
    const previous = input.sourceAdmissionId ? teamTasks.admission(this.db, input.sourceAdmissionId) : null;
    const check = () => {
      const availability = this.availability(input.taskId, previous ? "retry" : input.kind);
      if (!availability.allowed) throw new Error(availability.reason!);
      if (previous) {
        if (previous.taskId !== input.taskId || previous.instanceId !== initial.instance.id || this.projectAdmissionWithoutRetry(previous) !== "stopped")
          throw new Error("Only a stopped request can be admitted again with its retained input.");
        if (teamTasks.admissions(this.db, input.taskId).some((item) => item.sourceAdmissionId === previous.id))
          throw new Error("This request was already retried. Use the latest request's recovery controls.");
        if (teamTasks.admissions(this.db, input.taskId).some((item) => !done(this.projectAdmissionWithoutRetry(item)))) throw new Error("This task already has unfinished accepted work.");
      }
      if (input.runId) {
        const record = this.authority.statusForRun(input.runId);
        if (record.instanceId !== initial.instance.id || runs.get(this.db, input.runId)?.mode !== "act") throw new Error("Only this task's team can request execution in Act mode.");
      }
    };
    check();
    const selection = input.kind === "review" && !previous ? this.controls.review.composeSelectedComments(input.taskId, input.commentIds ?? []) : null;
    const snapshot = previous?.input ?? TeamTaskInputSnapshot.parse({ title: initial.task.title, spec: initial.task.spec ?? "", attachments: await this.controls.images(initial.task.spec ?? "") });
    let active = teamRuntime.activeForThread(this.db, initial.thread.id);
    const plan = !active
      ? await this.authority.validateStart({ projectId: initial.task.projectId, teamRevisionId: initial.revision.id, leadOverrides: initial.instance.leadOverrides, allowArchived: true })
      : null;
    const admission = this.db.transaction(() => {
      const concurrent = replay();
      if (concurrent) return concurrent;
      check();
      const current = this.scope(input.taskId);
      if (!previous && (current.task.title !== initial.task.title || current.task.spec !== initial.task.spec))
        throw new Error("The task document changed while its images were loading. Retry with the saved document.");
      if (selection && JSON.stringify(this.controls.review.composeSelectedComments(input.taskId, input.commentIds!)) !== JSON.stringify(selection))
        throw new Error("The selected comments changed before delivery. Review the selection and retry.");
      const intent = teamTasks.createIntent(this.db, this.describeIntent(input.taskId));
      const batch = admissionReviewBatch({ db: this.db, previous, selection, instanceId: intent.instanceId, taskId: input.taskId });
      const accepted = teamTasks.createAdmission(this.db, {
        id: randomUUID(),
        instanceId: intent.instanceId,
        taskId: input.taskId,
        requestKey: input.requestKey,
        payloadHash,
        kind: input.kind,
        input: snapshot,
        reviewBatchId: batch?.id ?? null,
        sourceAdmissionId: previous?.id ?? null,
        source: previous ? previous.source : this.source(input.taskId),
        createdAt: Date.now(),
      });
      active = teamRuntime.activeForThread(this.db, current.thread.id);
      let messageId: string | null = null;
      let target = active && input.kind === "review" ? this.activeActor(input.taskId, active) : null;
      let managerId = "lead";
      const sourceActor = accepted.source ? this.authority.status(accepted.source.executionId).actors.find((item) => item.id === accepted.source!.actorId) : null;
      const self = intent.memberKey === null && intent.parentTaskId === null && (current.revision.members.length === 1 || sourceActor?.id === "lead");
      if (!active) {
        if (!plan) throw new Error("The team stopped during admission. Retry to validate its next execution.");
        this.authority.assertQuiescent(current.thread.id);
        active = this.authority.admit({
          threadId: current.thread.id,
          prompt: this.prompt(accepted, self ? "assignee" : "manager"),
          attachments: snapshot.attachments,
          plan,
          expectedConfigurationVersion: initial.instance.configurationVersion,
          admission: { scope: "thread", requestKey: `task:${accepted.id}`, payloadHash },
          sourceTaskAdmissionId: accepted.id,
        });
        if (self) target = active.actors[0]!;
      } else {
        if (!target && self) target = active.actors[0]!;
        if (input.runId && !target) managerId = this.authority.binding(input.runId)!.actorId;
        else
          messageId = this.authority.steerActor(active.id, target?.id ?? managerId, {
            text: this.prompt(accepted, target ? "assignee" : "manager"),
            requestKey: `task:${accepted.id}`,
            attachments: snapshot.attachments,
          }).id;
      }
      teamTasks.appendRoute(this.db, {
        admissionId: accepted.id,
        sequence: 1,
        executionId: active.id,
        actorId: target?.id ?? managerId,
        messageId,
        role: target ? "assignee" : "manager",
        createdAt: Date.now(),
      });
      if (target) tasks.update(this.db, input.taskId, { status: "in_progress", completedAt: null });
      threads.update(this.db, current.thread.id, { doneAt: null, snoozedUntil: null });
      audit.record(this.db, {
        actor: input.runId ? "agent" : "user",
        action: `team.task.${previous ? "retry" : input.kind}`,
        resourceType: "task",
        resourceId: input.taskId,
        metadata: { admissionId: accepted.id, reviewBatchId: accepted.reviewBatchId },
      });
      return accepted;
    });
    this.changed(input.taskId);
    return { admissionId: admission.id, task: this.state(input.taskId)! };
  }

  async toolStart(runId: string, input: { taskId: string; admissionId?: string; memberKey?: string; requestKey?: string }): Promise<TeamTaskActionResult | null> {
    const record = this.authority.statusForRun(runId);
    const caller = record.actors.find((item) => item.id === this.authority.binding(runId)!.actorId)!;
    const scope = this.scope(input.taskId);
    if (scope.instance.id !== record.instanceId || scope.thread.mode !== "act" || runs.get(this.db, runId)?.mode !== "act") throw new Error("Only this task's team can start it in Act mode.");
    let admission = input.admissionId
      ? teamTasks.admission(this.db, input.admissionId)
      : teamTasks.admissions(this.db, input.taskId).findLast((item) => !done(this.projectAdmissionWithoutRetry(item)));
    if (input.admissionId && (!admission || admission.taskId !== input.taskId)) throw new Error("The accepted request belongs to another task.");
    if (!admission) {
      const existing = this.activeActor(input.taskId, record);
      if (existing) {
        if (existing.parentId !== caller.id) throw new Error("Only this assignment's manager can start it.");
        if (existing.state === "attention") this.authority.retry(record.id, existing.id);
        return null;
      }
      const requestKey = input.requestKey ?? `tool:${hash([caller.memberKey, caller.taskId, input.taskId, input.memberKey ?? null])}`;
      const accepted = await this.accept({ taskId: input.taskId, requestKey, kind: "start", runId });
      admission = teamTasks.admission(this.db, accepted.admissionId)!;
    }
    this.route(runId, admission, input.memberKey);
    this.changed(input.taskId);
    return { admissionId: admission.id, task: this.state(input.taskId)! };
  }

  private route(runId: string, admission: TeamTaskAdmission, requestedMember?: string): void {
    this.db.transaction(() => {
      const record = this.authority.statusForRun(runId);
      const caller = record.actors.find((item) => item.id === this.authority.binding(runId)!.actorId)!;
      if (taskForwardings.source(this.db, admission.taskId)) throw new Error("This task has been forwarded to an independent agent.");
      const scope = this.scope(admission.taskId);
      if (record.instanceId !== admission.instanceId || scope.thread.mode !== "act" || runs.get(this.db, runId)?.mode !== "act")
        throw new Error("This task can only be assigned by its team in Act mode.");
      const intent = teamTasks.intent(this.db, admission.taskId)!;
      const routes = teamTasks.routes(this.db, admission.id);
      const previous = routes.at(-1)!;
      if (previous.executionId !== record.id) throw new Error("This request belongs to an earlier execution. Retry its retained input from the task.");
      const existing = record.actors.find((item) => item.id === previous.actorId)!;
      if (previous.role === "assignee" || previous.actorId !== caller.id) {
        if (((existing.id === caller.id && existing.id === "lead") || existing.parentId === caller.id) && (!requestedMember || requestedMember === existing.memberKey)) return;
        throw new Error("This request has already been routed to another assigned agent. Its routing is retained.");
      }
      let memberKey = intent.managerKey;
      let managerTaskId = intent.parentTaskId;
      if (caller.memberKey !== intent.managerKey || caller.taskId !== intent.parentTaskId) {
        let member = scope.revision.members.find((item) => item.key === memberKey)!;
        while (member.managerKey && member.managerKey !== caller.memberKey) {
          managerTaskId = managerTaskId ? (tasks.get(this.db, managerTaskId)?.parentTaskId ?? null) : null;
          member = scope.revision.members.find((item) => item.key === member.managerKey)!;
        }
        memberKey = member.key;
        if (member.managerKey !== caller.memberKey || !managerTaskId || tasks.get(this.db, managerTaskId)?.parentTaskId !== caller.taskId)
          throw new Error("Route this task through its saved manager hierarchy.");
        if (requestedMember && requestedMember !== memberKey) throw new Error(`Route this task through direct manager ${memberKey} first.`);
        const busy = record.actors.find((item) => item.memberKey === memberKey && !item.participant && !terminal(item.state));
        if (busy && (busy.taskId !== managerTaskId || busy.parentId !== caller.id))
          throw new Error("This manager already has another active assignment. Wait for it before routing the retained task.");
        const managerTask = tasks.get(this.db, managerTaskId)!;
        const manager =
          busy ??
          this.authority.reserveTask(runId, {
            taskId: managerTask.id,
            memberKey,
            requestKey: `route:${admission.id}`,
            input: {
              title: managerTask.title,
              spec: `Coordinate this follow-up through your saved hierarchy. Preserve the existing task IDs; do not repeat completed implementation.\n\nManager task context:\n${managerTask.spec ?? ""}\n\n${this.prompt(admission)}`,
              attachments: admission.input.attachments,
            },
          });
        const message = this.authority.steerActor(record.id, manager.id, { text: this.prompt(admission), requestKey: `route:${admission.id}`, attachments: admission.input.attachments });
        teamTasks.appendRoute(this.db, {
          admissionId: admission.id,
          sequence: routes.length + 1,
          executionId: record.id,
          actorId: manager.id,
          messageId: message.id,
          role: "manager",
          createdAt: Date.now(),
        });
        return;
      }
      const sourceActor = admission.source ? this.authority.status(admission.source.executionId).actors.find((item) => item.id === admission.source!.actorId) : null;
      const selected = requestedMember ?? sourceActor?.memberKey ?? intent.memberKey ?? (caller.id === "lead" ? caller.memberKey : null);
      if (!selected) throw new Error("Choose a saved direct-report member for this task.");
      const dependencies = teamTaskDependencies(this.db, record, caller, intent);
      let actor: TeamActorRecord;
      let messageId: string | null = null;
      if (selected === caller.memberKey && caller.id === "lead") {
        if (intent.memberKey !== null || dependencies.length) throw new Error("The lead can claim an unassigned task after its prerequisites finish.");
        actor = caller;
        messageId = this.authority.steerActor(record.id, caller.id, {
          text: `${this.prompt(admission, "assignee")}\n\nYou are the assignee. Complete it with task_complete using this admission_id, then finish your turn successfully.`,
          requestKey: `claim:${admission.id}`,
          attachments: admission.input.attachments,
        }).id;
      } else {
        const active = this.activeActor(admission.taskId, record);
        if (active) {
          if (active.memberKey !== selected || active.parentId !== caller.id) throw new Error("This task is already assigned to another agent.");
          actor = active;
          messageId = this.authority.steerActor(record.id, actor.id, { text: this.prompt(admission, "assignee"), requestKey: `feedback:${admission.id}`, attachments: admission.input.attachments }).id;
        } else
          actor = this.authority.reserveTask(runId, {
            taskId: admission.taskId,
            memberKey: selected,
            requestKey: `task:${admission.id}`,
            input: { title: admission.input.title, spec: this.prompt(admission, "assignee"), attachments: admission.input.attachments },
            dependencies,
          });
      }
      teamTasks.appendRoute(this.db, { admissionId: admission.id, sequence: routes.length + 1, executionId: record.id, actorId: actor.id, messageId, role: "assignee", createdAt: Date.now() });
      tasks.update(this.db, admission.taskId, { status: "in_progress", completedAt: null });
    });
  }

  completeTask(runId: string, input: { taskId: string; admissionId?: string; result: string }): void {
    const record = this.authority.statusForRun(runId);
    if (runs.get(this.db, runId)?.mode !== "act") throw new Error("A Plan turn cannot complete an execution task. Return to Act to carry out its retained instructions.");
    this.authority.assertCurrentDirection(runId);
    const binding = this.authority.binding(runId)!;
    const actor = record.actors.find((item) => item.id === binding.actorId)!;
    if (actor.id !== "lead") {
      if (actor.taskId !== input.taskId) throw new Error("Complete only your own assigned task.");
      if (input.admissionId) {
        const admission = teamTasks.admission(this.db, input.admissionId);
        const route = admission ? teamTasks.routes(this.db, admission.id).at(-1) : null;
        if (admission?.taskId !== input.taskId || route?.executionId !== record.id || route.actorId !== actor.id || route.role !== "assignee")
          throw new Error("Complete only a request assigned to your task.");
      }
      this.authority.complete(runId, { result: input.result });
      return;
    }
    const candidates = teamTasks.admissions(this.db, input.taskId).filter((admission) => {
      if (input.admissionId && admission.id !== input.admissionId) return false;
      const route = teamTasks.routes(this.db, admission.id).at(-1);
      return route?.executionId === record.id && route.actorId === actor.id && route.role === "assignee" && !teamTaskCompletions.get(this.db, admission.id);
    });
    if (candidates.length !== 1) throw new Error("Specify the exact accepted admission_id to complete this task.");
    const retained = teamTaskCompletions.intent(this.db, candidates[0]!.id, binding.attemptId);
    if (retained && retained.result !== input.result.trim()) throw new Error("This task already has a different completion result for this turn.");
    teamTaskCompletions.request(
      this.db,
      retained ?? { admissionId: candidates[0]!.id, executionId: record.id, actorId: "lead", attemptId: binding.attemptId, result: input.result, createdAt: Date.now() },
    );
    this.changed(input.taskId);
  }

  private required(record: TeamExecutionRecord, actor: TeamActorRecord) {
    return this.history(record.instanceId).flatMap((admission) => {
      const route = teamTasks.routes(this.db, admission.id).at(-1);
      return route?.executionId === record.id && route.actorId === actor.id && this.projectAdmissionWithoutRetry(admission) !== "stopped" && !teamTaskCompletions.get(this.db, admission.id)
        ? [{ admission, route }]
        : [];
    });
  }

  hasPendingWork(record: TeamExecutionRecord, actor: TeamActorRecord): boolean {
    return this.required(record, actor).length > 0;
  }

  instructions(record: TeamExecutionRecord, actor: TeamActorRecord): string {
    const required = this.required(record, actor);
    const attempt = record.attempts.findLast((item) => item.actorId === actor.id);
    const mode = attempt?.mode ?? (attempt?.runId ? runs.get(this.db, attempt.runId)?.mode : undefined);
    if (mode === "plan")
      return [
        "This Plan turn may discuss the retained accepted tasks below. Their IDs, input and assignment requirements are preserved for Act. Do not start, route, implement or complete these execution tasks in Plan. End an ordinary successful planning reply; unfinished work remains waiting for Act.",
        ...required.map(
          ({ admission, route }) => `Retained ${route.role === "manager" ? "assignment request" : "accepted task"}: ${admission.id}; task ${admission.taskId}; ${admission.input.title}.`,
        ),
      ].join("\n");
    return [
      "Saved tasks keep their original IDs and accepted input. task_start accepts id, admission_id, and optional member_key. Route required manager requests before completing. An assigned worker uses team_complete normally; the lead must use task_complete(id, admission_id, result) for each task it handles itself, then end a successful turn. task_complete records intent; a successful captured turn makes it final.",
      ...required.map(({ admission, route }) => `${route.role === "manager" ? "REQUIRES ASSIGNMENT" : "YOUR ACCEPTED TASK"}: ${admission.id}; task ${admission.taskId}; ${admission.input.title}.`),
    ].join("\n");
  }

  completionReason(record: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord): string | null {
    for (const { admission, route } of this.required(record, actor)) {
      if (route.role === "manager") return `Required task ${admission.taskId} has not been assigned. Use task_start with admission_id ${admission.id}.`;
      if (actor.id === "lead" && !teamTaskCompletions.intent(this.db, admission.id, attempt.id))
        return `Record task_complete for task ${admission.taskId}, admission_id ${admission.id}, before completing.`;
    }
    return null;
  }

  settled(record: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, outcome: TurnSettledOutcome): void {
    if (!attempt.runId || runs.get(this.db, attempt.runId)?.mode !== "act") return;
    if (
      outcome.status !== "success" ||
      !outcome.snapshotId ||
      !attempt.runId ||
      record.messages.some((message) => message.recipientId === actor.id && message.state !== "cancelled" && message.state !== "delivered")
    )
      return;
    for (const { admission, route } of this.required(record, actor)) {
      if (route.role !== "assignee") continue;
      if (actor.id === "lead") {
        const intent = teamTaskCompletions.intent(this.db, admission.id, attempt.id);
        if (!intent) continue;
        const checkpoint = checkpoints.get(this.db, outcome.snapshotId);
        if (!checkpoint || checkpoint.threadId !== record.threadId) throw new Error("The lead's task output has no owned checkpoint.");
        const snapshot = snapshots.insert(this.db, {
          taskId: admission.taskId,
          runId: attempt.runId,
          turn: record.attempts.filter((item) => item.actorId === actor.id).length,
          treeSha: checkpoint.treeSha,
          diffStat: checkpoint.diffStat,
        });
        teamTaskCompletions.complete(this.db, { ...intent, runId: attempt.runId, snapshotId: snapshot.id, createdAt: Date.now() });
        const workspace = teamWorkspaces.get(this.db, record.id, actor.id);
        tasks.update(this.db, admission.taskId, { status: "review", ...(workspace ? { workspaceMode: "worktree", worktreePath: workspace.path, baseSha: workspace.source.headSha } : {}) });
      }
      if (admission.reviewBatchId) {
        const batch = teamTasks.batch(this.db, admission.reviewBatchId)!;
        const unsent = new Set(
          comments
            .listForTask(this.db, admission.taskId)
            .filter((comment) => comment.sentInRunId === null)
            .map((comment) => comment.id),
        );
        comments.markSent(
          this.db,
          batch.comments.filter((comment) => unsent.has(comment.id)).map((comment) => comment.id),
          attempt.runId,
        );
      }
      this.changed(admission.taskId);
    }
  }

  private changed(taskId: string): void {
    const task = tasks.get(this.db, taskId);
    this.invalidate(["tasks", "threads", "orchestration", "inbox", `task:${taskId}`, `comments:${taskId}`, ...(task?.threadId ? [`thread:${task.threadId}`] : [])]);
  }

  private captureRequest(runId: string, raw: CaptureTeamTaskInput) {
    const input = captureInput.parse(raw);
    const record = this.authority.statusForRun(runId);
    const binding = this.authority.binding(runId);
    const actor = record.actors.find((item) => item.id === binding?.actorId);
    const run = runs.get(this.db, runId);
    const thread = threads.get(this.db, record.threadId);
    const instance = orchestration.getInstance(this.db, record.threadId);
    if (!actor || !run || !thread || instance?.id !== record.instanceId) throw new Error("The task capture no longer has an owning team.");
    if (input.execution === "delegate" && (!input.memberKey || !input.requestKey)) throw new Error("Team proposals require member_key and request_key.");
    const revision = orchestration.getRevision(this.db, instance.teamRevisionId)!;
    // A leaf captures work for its manager to allocate. It cannot invent a
    // reporting level beneath itself or turn capture into self-delegation.
    const manager = revision.members.some((member) => member.managerKey === actor.memberKey) || actor.id === "lead" ? actor : record.actors.find((item) => item.id === actor.parentId)!;
    if (!manager) throw new Error("The capturing agent's manager was not found.");
    if (input.dependencies.length && input.dependencyTaskIds.length) throw new Error("Choose assignment dependencies or task dependencies, not both.");
    const dependencyTaskIds = input.dependencies.length
      ? input.dependencies.map((id) => {
          const dependency = record.actors.find((item) => item.id === id && item.parentId === manager.id);
          if (!dependency?.taskId) throw new Error("Dependencies must be assignments owned by this task's manager.");
          return dependency.taskId;
        })
      : input.dependencyTaskIds;
    const request = { title: input.title, spec: input.spec, priority: input.priority, labels: input.labels, execution: input.execution, memberKey: input.memberKey ?? null, dependencyTaskIds };
    const payloadHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const scope = JSON.stringify([manager.memberKey, manager.taskId]);
    const requestKey = input.requestKey ?? `capture:${payloadHash}`;
    return { input, record, actor, run, thread, instance, revision, manager, dependencyTaskIds, payloadHash, scope, requestKey };
  }

  private retainedCapture(request: ReturnType<TeamTaskService["captureRequest"]>): Task | null {
    const previous = teamTasks.findCapture(this.db, request.instance.id, request.scope, request.requestKey);
    if (!previous) return null;
    if (previous.capture?.payloadHash !== request.payloadHash) throw new Error("This capture request key already identifies a different task. Reuse its original input or choose a new request key.");
    const task = tasks.get(this.db, previous.taskId);
    if (!task) throw new Error("The captured task is missing; preserve its receipt before retrying.");
    return task;
  }

  captureReplay(runId: string, raw: CaptureTeamTaskInput): { task: Task; duplicate: boolean; started: false; message: string } | null {
    const task = this.retainedCapture(this.captureRequest(runId, raw));
    return task ? this.captureResult(task, true) : null;
  }

  capture(runId: string, raw: CaptureTeamTaskInput): { task: Task; duplicate: boolean; started: false; message: string } {
    const result = this.db.transaction(() => {
      const request = this.captureRequest(runId, raw);
      const retained = this.retainedCapture(request);
      if (retained) return { task: retained, duplicate: true };
      const { input, record, actor, run, thread, instance, revision, manager, dependencyTaskIds, payloadHash, scope, requestKey } = request;
      if (input.execution === "delegate" && run.mode === "act" && thread.mode === "act") throw new Error("Immediate team delegation must reserve an assignment through the coordinator.");
      const task = tasks.insert(this.db, {
        projectId: record.projectId,
        threadId: record.threadId,
        title: input.title,
        spec: input.spec,
        priority: input.priority,
        labels: input.labels,
        status: input.execution === "backlog" ? "backlog" : "proposed",
        workspaceMode: "worktree",
        baseRef: null,
        parentTaskId: manager.taskId,
        origin: "agent",
      });
      teamTasks.createIntent(this.db, {
        taskId: task.id,
        instanceId: instance.id,
        teamRevisionId: revision.id,
        managerKey: manager.memberKey,
        memberKey: input.memberKey ?? null,
        parentTaskId: manager.taskId,
        dependencyTaskIds,
        origin: { executionId: record.id, actorId: actor.id },
        capture: { scope, requestKey, payloadHash },
        createdAt: Date.now(),
      });
      audit.record(this.db, {
        actor: "agent",
        action: "team.task.capture",
        resourceType: "task",
        resourceId: task.id,
        metadata: { executionId: record.id, actorId: actor.id, managerKey: manager.memberKey, memberKey: input.memberKey ?? null, status: task.status },
      });
      return { task, duplicate: false };
    });
    if (!result.duplicate) this.invalidate(["tasks", "threads", `thread:${result.task.threadId}`, `task:${result.task.id}`, "orchestration"]);
    return this.captureResult(result.task, result.duplicate);
  }

  private captureResult(task: Task, duplicate: boolean): { task: Task; duplicate: boolean; started: false; message: string } {
    return {
      task,
      duplicate,
      started: false,
      message: capturedTaskMessage(task, duplicate),
    };
  }
}

/** The team owns a task's status only while an assignment is still running or a request is still queued, received or running. */
export function teamWorking(assignments: Pick<TeamTaskView["assignments"][number], "state">[], admissions: Pick<TeamTaskAdmissionView, "state">[]): boolean {
  return (
    assignments.some((assignment) => assignment.state !== "completed" && assignment.state !== "cancelled") ||
    admissions.some((admission) => admission.state === "queued" || admission.state === "received" || admission.state === "running")
  );
}
