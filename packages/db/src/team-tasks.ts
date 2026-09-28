import { TeamReviewBatch, TeamTaskAdmission, TeamTaskAdmissionRoute, TeamTaskIntent, teamReviewComment, type TeamTaskActorReference } from "@openorc/protocol";
import type { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { comments, snapshots, tasks, threads } from "./repos.js";
import { teamRuntime } from "./team-runtime.js";

interface IntentRow {
  task_id: string;
  instance_id: string;
  revision_id: string;
  capture_scope: string | null;
  capture_key: string | null;
  payload: string;
  created_at: number;
}
interface BatchRow {
  id: string;
  instance_id: string;
  task_id: string;
  payload: string;
  created_at: number;
}
interface AdmissionRow extends BatchRow {
  request_key: string;
  review_batch_id: string | null;
  source_admission_id: string | null;
}
interface RouteRow {
  admission_id: string;
  sequence: number;
  execution_id: string;
  actor_id: string;
  message_id: string | null;
  role: TeamTaskAdmissionRoute["role"];
  created_at: number;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function requireInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid team task history: ${message}`);
}
function retained<T>(previous: T, proposed: T, label: string): T {
  requireInvariant(same(previous, proposed), `${label} already identifies different retained input.`);
  return previous;
}
function owner(db: Db, taskId: string, instanceId: string) {
  const task = tasks.get(db, taskId);
  const thread = task?.threadId ? threads.get(db, task.threadId) : null;
  const instance = thread ? orchestration.getInstance(db, thread.id) : null;
  const revision = instance ? orchestration.getRevision(db, instance.teamRevisionId) : null;
  requireInvariant(
    task && thread && instance?.id === instanceId && revision && task.projectId === thread.projectId && revision.projectId === task.projectId,
    `task ${taskId} must belong to its pinned instance, thread, project, and revision.`,
  );
  return { task, thread, instance, revision };
}
function exactActor(db: Db, instanceId: string, reference: TeamTaskActorReference) {
  const execution = teamRuntime.get(db, reference.executionId);
  const actor = execution?.actors.find((item) => item.id === reference.actorId);
  requireInvariant(execution?.instanceId === instanceId && actor, "actor provenance must belong to its exact execution and instance.");
  if (actor.id !== "lead") requireInvariant(teamRuntime.assignment(db, execution.id, actor.id)?.taskId === actor.taskId, "actor provenance must retain its exact historical task binding.");
  return { execution, actor };
}
function decodeIntent(row: IntentRow): TeamTaskIntent {
  const record = TeamTaskIntent.parse(JSON.parse(row.payload));
  requireInvariant(
    record.taskId === row.task_id &&
      record.instanceId === row.instance_id &&
      record.teamRevisionId === row.revision_id &&
      (record.capture?.scope ?? null) === row.capture_scope &&
      (record.capture?.requestKey ?? null) === row.capture_key &&
      record.createdAt === row.created_at,
    "intent payload differs from its indexed identity; preserve the database for recovery.",
  );
  return record;
}
function readIntent(db: Db, taskId: string): TeamTaskIntent | null {
  const row = db.stmt("SELECT * FROM team_task_intents WHERE task_id = ?").get(taskId) as unknown as IntentRow | undefined;
  return row ? decodeIntent(row) : null;
}
function validateIntent(db: Db, record: TeamTaskIntent): void {
  const scope = owner(db, record.taskId, record.instanceId);
  requireInvariant(scope.revision.id === record.teamRevisionId && scope.task.parentTaskId === record.parentTaskId, "intent must retain its pinned revision and parent task provenance.");
  const manager = scope.revision.members.find((member) => member.key === record.managerKey);
  const member = record.memberKey === null ? null : scope.revision.members.find((item) => item.key === record.memberKey);
  requireInvariant(manager && (record.memberKey === null || member?.managerKey === manager.key), "intent assignee must be a direct report of its saved manager.");
  if (manager.managerKey === null) requireInvariant(record.parentTaskId === null, "lead-managed task must not claim another task as its parent.");
  else {
    requireInvariant(record.parentTaskId !== null && record.parentTaskId !== record.taskId, "nested intent requires its manager's parent task.");
    owner(db, record.parentTaskId, record.instanceId);
    const parentIntent = readIntent(db, record.parentTaskId);
    const matches =
      (parentIntent?.instanceId === record.instanceId && parentIntent.memberKey === manager.key) ||
      teamRuntime.assignmentsForTask(db, record.parentTaskId).some((binding) => {
        const historical = exactActor(db, record.instanceId, binding);
        return historical.actor.memberKey === manager.key;
      });
    requireInvariant(matches, "intent parent task must retain its manager member provenance.");
  }
  if (record.origin) {
    const { actor, execution } = exactActor(db, record.instanceId, record.origin);
    const parent = execution.actors.find((item) => item.id === actor.parentId);
    requireInvariant(
      (actor.memberKey === record.managerKey && actor.taskId === record.parentTaskId) || (parent?.memberKey === record.managerKey && parent.taskId === record.parentTaskId),
      "intent origin must be its requesting manager or that manager's own direct report.",
    );
  }
  for (const binding of teamRuntime.assignmentsForTask(db, record.taskId)) {
    const historical = exactActor(db, record.instanceId, binding);
    const parent = historical.execution.actors.find((item) => item.id === historical.actor.parentId);
    requireInvariant(
      (record.memberKey === null || historical.actor.memberKey === record.memberKey) && parent?.memberKey === record.managerKey && parent.taskId === record.parentTaskId,
      "intent must preserve the task's historical member and parent task provenance.",
    );
  }
  requireInvariant(
    new Set(record.dependencyTaskIds).size === record.dependencyTaskIds.length && !record.dependencyTaskIds.includes(record.taskId),
    "intent dependencies must be unique and cannot include the task itself.",
  );
  for (const taskId of record.dependencyTaskIds) {
    owner(db, taskId, record.instanceId);
    const dependency = readIntent(db, taskId);
    const matches =
      (dependency?.instanceId === record.instanceId && dependency.managerKey === record.managerKey && dependency.parentTaskId === record.parentTaskId) ||
      teamRuntime.assignmentsForTask(db, taskId).some((binding) => {
        const historical = exactActor(db, record.instanceId, binding);
        const parent = historical.execution.actors.find((item) => item.id === historical.actor.parentId);
        return parent?.memberKey === record.managerKey && parent.taskId === record.parentTaskId;
      });
    requireInvariant(matches, "intent dependency must retain its sibling manager and parent task provenance.");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    requireInvariant(!visiting.has(taskId), "intent dependencies contain a cycle.");
    owner(db, taskId, record.instanceId);
    const intent = taskId === record.taskId ? record : readIntent(db, taskId);
    requireInvariant(!intent || intent.instanceId === record.instanceId, "intent dependency belongs to another instance.");
    visiting.add(taskId);
    for (const dependency of intent?.dependencyTaskIds ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  visit(record.taskId);
}
function intent(db: Db, taskId: string): TeamTaskIntent | null {
  const record = readIntent(db, taskId);
  if (record) validateIntent(db, record);
  return record;
}
function intentOwner(db: Db, taskId: string, instanceId: string): TeamTaskIntent {
  const record = intent(db, taskId);
  requireInvariant(record?.instanceId === instanceId, "task input must belong to its retained intent and instance.");
  return record;
}
function decodeBatch(row: BatchRow): TeamReviewBatch {
  const record = TeamReviewBatch.parse(JSON.parse(row.payload));
  requireInvariant(
    record.id === row.id && record.instanceId === row.instance_id && record.taskId === row.task_id && record.createdAt === row.created_at,
    "review batch payload differs from its indexed identity; preserve the database for recovery.",
  );
  return record;
}
function validateBatch(db: Db, record: TeamReviewBatch): void {
  intentOwner(db, record.taskId, record.instanceId);
  requireInvariant(new Set(record.comments.map((comment) => comment.id)).size === record.comments.length, "review batch comments must be unique.");
  for (const comment of record.comments) {
    requireInvariant(comment.taskId === record.taskId && comment.sentInRunId === null, "review batch requires unsent comments from its own task.");
    if (comment.snapshotId !== null) requireInvariant(snapshots.get(db, comment.snapshotId)?.taskId === record.taskId, "review comment snapshot must belong to its own task.");
  }
}
function batch(db: Db, id: string): TeamReviewBatch | null {
  const row = db.stmt("SELECT * FROM team_review_batches WHERE id = ?").get(id) as unknown as BatchRow | undefined;
  if (!row) return null;
  const record = decodeBatch(row);
  validateBatch(db, record);
  const claims = db.stmt("SELECT comment_id FROM team_review_claims WHERE batch_id = ?").all(id) as { comment_id: string }[];
  requireInvariant(
    claims.length === record.comments.length && claims.every((claim) => record.comments.some((comment) => comment.id === claim.comment_id)),
    "review batch no longer matches its retained comment claims.",
  );
  return record;
}
function claim(db: Db, commentId: string): string | null {
  const row = db.stmt("SELECT batch_id FROM team_review_claims WHERE comment_id = ?").get(commentId) as { batch_id: string } | undefined;
  if (row)
    requireInvariant(
      batch(db, row.batch_id)?.comments.some((comment) => comment.id === commentId),
      "review claim has no matching retained batch.",
    );
  return row?.batch_id ?? null;
}
function decodeAdmission(row: AdmissionRow): TeamTaskAdmission {
  const record = TeamTaskAdmission.parse(JSON.parse(row.payload));
  requireInvariant(
    record.id === row.id &&
      record.instanceId === row.instance_id &&
      record.taskId === row.task_id &&
      record.requestKey === row.request_key &&
      record.reviewBatchId === row.review_batch_id &&
      record.sourceAdmissionId === row.source_admission_id &&
      record.createdAt === row.created_at,
    "admission payload differs from its indexed identity; preserve the database for recovery.",
  );
  return record;
}
function readAdmission(db: Db, id: string): TeamTaskAdmission | null {
  const row = db.stmt("SELECT * FROM team_task_admissions WHERE id = ?").get(id) as unknown as AdmissionRow | undefined;
  return row ? decodeAdmission(row) : null;
}
function decodeRoute(row: RouteRow): TeamTaskAdmissionRoute {
  return TeamTaskAdmissionRoute.parse({
    admissionId: row.admission_id,
    sequence: row.sequence,
    executionId: row.execution_id,
    actorId: row.actor_id,
    messageId: row.message_id,
    role: row.role,
    createdAt: row.created_at,
  });
}
function readRoutes(db: Db, admissionId: string): TeamTaskAdmissionRoute[] {
  return (db.stmt("SELECT * FROM team_task_admission_routes WHERE admission_id = ? ORDER BY sequence").all(admissionId) as unknown as RouteRow[]).map(decodeRoute);
}
function validateRoute(db: Db, route: TeamTaskAdmissionRoute, admission: TeamTaskAdmission): void {
  const taskIntent = intentOwner(db, admission.taskId, admission.instanceId);
  const scope = owner(db, admission.taskId, admission.instanceId);
  const { execution, actor } = exactActor(db, admission.instanceId, route);
  if (route.role === "manager") {
    let manager = scope.revision.members.find((member) => member.key === taskIntent.managerKey);
    let managerTaskId = taskIntent.parentTaskId;
    let matches = false;
    while (manager) {
      if (manager.key === actor.memberKey && managerTaskId === actor.taskId) {
        matches = true;
        break;
      }
      manager = scope.revision.members.find((member) => member.key === manager!.managerKey);
      managerTaskId = managerTaskId === null ? null : (tasks.get(db, managerTaskId)?.parentTaskId ?? null);
    }
    requireInvariant(matches, "manager route must follow the task's own manager lineage.");
  } else if (actor.id === "lead") {
    const lead = scope.revision.members.find((member) => member.managerKey === null)!;
    requireInvariant(
      taskIntent.memberKey === null && taskIntent.managerKey === lead.key && taskIntent.parentTaskId === null,
      "only an unassigned lead-managed task may route to the lead as assignee.",
    );
  } else {
    const parent = execution.actors.find((item) => item.id === actor.parentId);
    requireInvariant(
      actor.taskId === admission.taskId &&
        (taskIntent.memberKey === null || actor.memberKey === taskIntent.memberKey) &&
        parent?.memberKey === taskIntent.managerKey &&
        parent.taskId === taskIntent.parentTaskId,
      "assignee route must retain the task's direct member and parent task provenance.",
    );
  }
  if (route.messageId !== null) {
    const message = execution.messages.find((item) => item.id === route.messageId);
    requireInvariant(message?.recipientId === actor.id && message.kind === "direction", "route message must be a direction owned by its receiving actor.");
  }
}
function validateAdmission(db: Db, record: TeamTaskAdmission): void {
  intentOwner(db, record.taskId, record.instanceId);
  if (record.reviewBatchId !== null) {
    const retainedBatch = batch(db, record.reviewBatchId);
    requireInvariant(retainedBatch?.instanceId === record.instanceId && retainedBatch.taskId === record.taskId, "review admission must use its task's retained batch.");
  }
  const seen = new Set([record.id]);
  let previousId = record.sourceAdmissionId;
  while (previousId !== null) {
    requireInvariant(!seen.has(previousId), "source admissions contain a cycle.");
    seen.add(previousId);
    const previous = readAdmission(db, previousId);
    requireInvariant(
      previous?.instanceId === record.instanceId &&
        previous.taskId === record.taskId &&
        previous.kind === record.kind &&
        previous.reviewBatchId === record.reviewBatchId &&
        same(previous.input, record.input) &&
        same(previous.source, record.source),
      "retry admission must retain its source task, instance, kind, review batch, input, and actor provenance.",
    );
    previousId = previous.sourceAdmissionId;
  }
  if (record.source === null) return;
  const { execution, actor } = exactActor(db, record.instanceId, record.source);
  if (actor.id === "lead") {
    const rows = db
      .stmt(
        `SELECT a.* FROM team_task_admissions a JOIN team_task_admission_routes r ON r.admission_id = a.id
      WHERE a.task_id = ? AND a.instance_id = ? AND a.id <> ? AND r.execution_id = ? AND r.actor_id = 'lead' AND r.role = 'assignee'`,
      )
      .all(record.taskId, record.instanceId, record.id, execution.id) as unknown as AdmissionRow[];
    requireInvariant(
      rows.some((row) => {
        const previous = decodeAdmission(row);
        return readRoutes(db, previous.id).some((route) => {
          if (route.executionId !== execution.id || route.actorId !== "lead" || route.role !== "assignee") return false;
          validateRoute(db, route, previous);
          return true;
        });
      }),
      "lead source requires an earlier matching assignee route for this task.",
    );
  } else requireInvariant(actor.taskId === record.taskId, "admission source must be an exact historical assignment of its own task.");
  if (record.source.snapshotId !== null) {
    const snapshot = snapshots.get(db, record.source.snapshotId);
    const binding = snapshot?.runId ? teamRuntime.binding(db, snapshot.runId) : null;
    requireInvariant(snapshot?.taskId === record.taskId && binding?.executionId === execution.id && binding.actorId === actor.id, "admission snapshot must belong to its source actor's run and task.");
  }
}
function admission(db: Db, id: string): TeamTaskAdmission | null {
  const record = readAdmission(db, id);
  if (record) validateAdmission(db, record);
  return record;
}

/** Accepted task input and routing stay immutable, independently of provider turns. */
export const teamTasks = {
  intent,
  intents(db: Db, instanceId: string): TeamTaskIntent[] {
    return (db.stmt("SELECT * FROM team_task_intents WHERE instance_id = ? ORDER BY created_at, rowid").all(instanceId) as unknown as IntentRow[]).map((row) => {
      const record = decodeIntent(row);
      validateIntent(db, record);
      return record;
    });
  },
  findCapture(db: Db, instanceId: string, scope: string, key: string): TeamTaskIntent | null {
    const row = db.stmt("SELECT * FROM team_task_intents WHERE instance_id = ? AND capture_scope = ? AND capture_key = ?").get(instanceId, scope, key) as unknown as IntentRow | undefined;
    if (!row) return null;
    const record = decodeIntent(row);
    validateIntent(db, record);
    return record;
  },
  createIntent(db: Db, input: TeamTaskIntent): TeamTaskIntent {
    const record = TeamTaskIntent.parse(input);
    return db.transaction(() => {
      const previous = intent(db, record.taskId);
      if (previous) return retained(previous, record, "Task intent");
      if (record.capture) {
        const captured = teamTasks.findCapture(db, record.instanceId, record.capture.scope, record.capture.requestKey);
        if (captured) return retained(captured, record, "Capture request key");
      }
      validateIntent(db, record);
      db.stmt("INSERT INTO team_task_intents (task_id, instance_id, revision_id, capture_scope, capture_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        record.taskId,
        record.instanceId,
        record.teamRevisionId,
        record.capture?.scope ?? null,
        record.capture?.requestKey ?? null,
        JSON.stringify(record),
        record.createdAt,
      );
      return record;
    });
  },
  batch,
  claim,
  createBatch(db: Db, input: TeamReviewBatch): TeamReviewBatch {
    const record = TeamReviewBatch.parse(input);
    return db.transaction(() => {
      const previous = batch(db, record.id);
      if (previous) return retained(previous, record, "Review batch");
      validateBatch(db, record);
      const current = new Map(comments.listForTask(db, record.taskId).map((comment) => [comment.id, comment]));
      for (const comment of record.comments) {
        const source = current.get(comment.id);
        requireInvariant(
          source && same(comment, teamReviewComment(source)) && comment.sentInRunId === null,
          "selected review comment changed or was already sent; reload the comments before submitting.",
        );
        requireInvariant(claim(db, comment.id) === null, "selected review comment already belongs to a retained batch.");
      }
      db.stmt("INSERT INTO team_review_batches (id, instance_id, task_id, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
        record.id,
        record.instanceId,
        record.taskId,
        JSON.stringify(record),
        record.createdAt,
      );
      for (const comment of record.comments) db.stmt("INSERT INTO team_review_claims (comment_id, batch_id) VALUES (?, ?)").run(comment.id, record.id);
      return record;
    });
  },
  admission,
  admissions(db: Db, taskId: string): TeamTaskAdmission[] {
    return (db.stmt("SELECT * FROM team_task_admissions WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as unknown as AdmissionRow[]).map((row) => {
      const record = decodeAdmission(row);
      validateAdmission(db, record);
      return record;
    });
  },
  findRequest(db: Db, instanceId: string, requestKey: string): TeamTaskAdmission | null {
    const row = db.stmt("SELECT * FROM team_task_admissions WHERE instance_id = ? AND request_key = ?").get(instanceId, requestKey) as unknown as AdmissionRow | undefined;
    if (!row) return null;
    const record = decodeAdmission(row);
    validateAdmission(db, record);
    return record;
  },
  createAdmission(db: Db, input: TeamTaskAdmission): TeamTaskAdmission {
    const record = TeamTaskAdmission.parse(input);
    return db.transaction(() => {
      const previous = admission(db, record.id) ?? teamTasks.findRequest(db, record.instanceId, record.requestKey);
      if (previous) return retained(previous, record, "Admission request");
      validateAdmission(db, record);
      db.stmt("INSERT INTO team_task_admissions (id, instance_id, task_id, request_key, review_batch_id, source_admission_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        record.id,
        record.instanceId,
        record.taskId,
        record.requestKey,
        record.reviewBatchId,
        record.sourceAdmissionId,
        JSON.stringify(record),
        record.createdAt,
      );
      return record;
    });
  },
  /** The saved task whose accepted request is routed into this execution, newest route first. */
  admittingTask(db: Db, executionId: string): string | null {
    const row = db
      .stmt("SELECT a.task_id FROM team_task_admission_routes r JOIN team_task_admissions a ON a.id=r.admission_id WHERE r.execution_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1")
      .get(executionId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  },
  routes(db: Db, admissionId: string): TeamTaskAdmissionRoute[] {
    const routes = readRoutes(db, admissionId);
    if (!routes.length) return routes;
    const record = admission(db, admissionId);
    requireInvariant(record, "route has no retained admission.");
    for (const [index, route] of routes.entries()) {
      requireInvariant(route.sequence === index + 1, "admission route history must have contiguous sequence numbers.");
      validateRoute(db, route, record);
    }
    return routes;
  },
  appendRoute(db: Db, input: TeamTaskAdmissionRoute): TeamTaskAdmissionRoute {
    const record = TeamTaskAdmissionRoute.parse(input);
    return db.transaction(() => {
      const admission = teamTasks.admission(db, record.admissionId);
      requireInvariant(admission, "route requires a retained admission.");
      const routes = teamTasks.routes(db, record.admissionId);
      const previous = routes.find((route) => route.sequence === record.sequence);
      if (previous) return retained(previous, record, "Admission route sequence");
      requireInvariant(record.sequence === routes.length + 1, "admission route sequence must append contiguously.");
      requireInvariant(
        !routes.some((route) => route.executionId === record.executionId && route.actorId === record.actorId && route.role === record.role),
        "admission already has a route to this actor and role.",
      );
      validateRoute(db, record, admission);
      if (record.actorId === "lead" && record.role === "assignee" && record.messageId === null) {
        requireInvariant(!teamRuntime.get(db, record.executionId)!.attempts.some((attempt) => attempt.actorId === "lead"), "a running lead requires queued direction before receiving a task.");
      }
      db.stmt("INSERT INTO team_task_admission_routes (admission_id, sequence, execution_id, actor_id, message_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        record.admissionId,
        record.sequence,
        record.executionId,
        record.actorId,
        record.messageId,
        record.role,
        record.createdAt,
      );
      return record;
    });
  },
};
