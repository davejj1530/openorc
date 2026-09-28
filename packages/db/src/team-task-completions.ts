import { TeamTaskCompletion, TeamTaskCompletionIntent } from "@openorc/protocol";
import type { Db } from "./database.js";
import { runs, snapshots } from "./repos.js";
import { teamRuntime } from "./team-runtime.js";
import { teamTasks } from "./team-tasks.js";

interface IntentRow {
  admission_id: string;
  execution_id: string;
  actor_id: string;
  attempt_id: string;
  result: string;
  created_at: number;
}
interface CompletionRow extends IntentRow {
  run_id: string;
  snapshot_id: string;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid task completion: ${message}`);
}
function retained<T>(previous: T, proposed: T): T {
  check(JSON.stringify(previous) === JSON.stringify(proposed), "this completion request already retains different input.");
  return previous;
}
function decodeIntent(row: IntentRow): TeamTaskCompletionIntent {
  return TeamTaskCompletionIntent.parse({
    admissionId: row.admission_id,
    executionId: row.execution_id,
    actorId: row.actor_id,
    attemptId: row.attempt_id,
    result: row.result,
    createdAt: row.created_at,
  });
}
function scope(db: Db, record: TeamTaskCompletionIntent) {
  const admission = teamTasks.admission(db, record.admissionId);
  const execution = teamRuntime.get(db, record.executionId);
  const actor = execution?.actors.find((item) => item.id === record.actorId);
  const attempt = execution?.attempts.find((item) => item.id === record.attemptId);
  check(
    admission && execution?.instanceId === admission.instanceId && actor?.id === "lead" && actor.taskId === null && attempt?.actorId === actor.id,
    "admission and attempt must belong to the same lead actor and instance.",
  );
  const route = teamTasks.routes(db, admission.id).find((item) => item.executionId === execution.id && item.actorId === "lead" && item.role === "assignee");
  check(route, "admission requires an exact lead assignee route.");
  check(record.createdAt >= attempt.createdAt && record.createdAt >= route.createdAt, "completion intent predates its attempt or route.");
  const run = attempt.runId ? runs.get(db, attempt.runId) : null;
  const binding = run ? teamRuntime.binding(db, run.id) : null;
  check(
    run &&
      run.threadId === execution.threadId &&
      run.taskId === null &&
      binding?.executionId === execution.id &&
      binding.actorId === actor.id &&
      binding.attemptId === attempt.id &&
      binding.generation === attempt.generation,
    "attempt must retain its exact thread-owned lead run.",
  );
  return { admission, execution, actor, attempt, route, run };
}
function claimed(owner: ReturnType<typeof scope>): void {
  const { execution, attempt, route } = owner;
  if (route.messageId === null) {
    check(route.createdAt <= attempt.createdAt, "an initial assignee route must precede the attempt reservation.");
    return;
  }
  const message = execution.messages.find((item) => item.id === route.messageId);
  check(message && message.recipientId === "lead" && message.kind === "direction", "route must retain its lead direction.");
  if ((message.state === "claimed" || message.state === "delivered") && message.attemptId === attempt.id && attempt.messageIds.includes(message.id)) return;
  const previous = execution.attempts.find((item) => item.id === message.attemptId);
  check(
    message.state === "delivered" &&
      message.deliveredAt !== null &&
      message.deliveredAt <= attempt.createdAt &&
      previous?.actorId === "lead" &&
      previous.messageIds.includes(message.id) &&
      execution.attempts.indexOf(previous) < execution.attempts.indexOf(attempt),
    "the route direction must be claimed by this attempt or delivered before it.",
  );
}
function intent(db: Db, admissionId: string, attemptId: string): TeamTaskCompletionIntent | null {
  const row = db.stmt("SELECT * FROM team_task_completion_intents WHERE admission_id = ? AND attempt_id = ?").get(admissionId, attemptId) as unknown as IntentRow | undefined;
  if (!row) return null;
  const record = decodeIntent(row);
  scope(db, record);
  return record;
}
function validateCompletion(db: Db, record: TeamTaskCompletion): void {
  const requested = intent(db, record.admissionId, record.attemptId);
  check(
    requested && requested.executionId === record.executionId && requested.actorId === record.actorId && requested.result === record.result && record.createdAt >= requested.createdAt,
    "successful completion requires its exact earlier intent and result.",
  );
  const owner = scope(db, record);
  const { attempt, run, admission } = owner;
  check(
    attempt.state === "closed" && attempt.endedAt !== null && attempt.error === null && attempt.snapshotId !== null && run.id === record.runId && run.state === "success" && run.endedAt !== null,
    "completion requires the closed successful lead run and captured turn.",
  );
  const snapshot = snapshots.get(db, record.snapshotId);
  check(snapshot?.taskId === admission.taskId && snapshot.runId === run.id, "snapshot must belong to this task and exact lead run.");
}
function get(db: Db, admissionId: string): TeamTaskCompletion | null {
  const row = db.stmt("SELECT * FROM team_task_completions WHERE admission_id = ?").get(admissionId) as unknown as CompletionRow | undefined;
  if (!row) return null;
  const record = TeamTaskCompletion.parse({ ...decodeIntent(row), runId: row.run_id, snapshotId: row.snapshot_id });
  validateCompletion(db, record);
  return record;
}

/** A lead may complete real tasks without becoming a synthetic task actor. */
export const teamTaskCompletions = {
  intent,
  intentsForAttempt(db: Db, executionId: string, attemptId: string): TeamTaskCompletionIntent[] {
    return (db.stmt("SELECT * FROM team_task_completion_intents WHERE execution_id = ? AND attempt_id = ? ORDER BY created_at, rowid").all(executionId, attemptId) as unknown as IntentRow[]).map(
      (row) => {
        const record = decodeIntent(row);
        scope(db, record);
        return record;
      },
    );
  },
  request(db: Db, input: TeamTaskCompletionIntent): TeamTaskCompletionIntent {
    const record = TeamTaskCompletionIntent.parse(input);
    return db.transaction(() => {
      const previous = intent(db, record.admissionId, record.attemptId);
      if (previous) return retained(previous, record);
      check(!get(db, record.admissionId), "this admission already has a successful completion.");
      const owner = scope(db, record);
      check(
        ["active", "attention"].includes(owner.execution.state) &&
          owner.attempt.generation === owner.execution.generation &&
          ["starting", "running"].includes(owner.attempt.state) &&
          ["starting", "running"].includes(owner.actor.state) &&
          owner.execution.attempts.findLast((item) => item.actorId === "lead")?.id === owner.attempt.id,
        "request requires the current starting or running lead attempt.",
      );
      claimed(owner);
      db.stmt("INSERT INTO team_task_completion_intents (admission_id, execution_id, actor_id, attempt_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        record.admissionId,
        record.executionId,
        record.actorId,
        record.attemptId,
        record.result,
        record.createdAt,
      );
      return record;
    });
  },
  get,
  complete(db: Db, input: TeamTaskCompletion): TeamTaskCompletion {
    const record = TeamTaskCompletion.parse(input);
    return db.transaction(() => {
      const previous = get(db, record.admissionId);
      if (previous) return retained(previous, record);
      validateCompletion(db, record);
      claimed(scope(db, record));
      db.stmt("INSERT INTO team_task_completions (admission_id, execution_id, actor_id, attempt_id, run_id, snapshot_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        record.admissionId,
        record.executionId,
        record.actorId,
        record.attemptId,
        record.runId,
        record.snapshotId,
        record.result,
        record.createdAt,
      );
      return record;
    });
  },
};
