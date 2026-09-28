/** Durable task intent and accepted review input; no provider execution is implied. */
export const teamTaskMigration = `
CREATE TABLE team_task_intents (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES orchestration_team_revisions(id),
  capture_scope TEXT,
  capture_key TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK((capture_scope IS NULL) = (capture_key IS NULL)),
  UNIQUE(instance_id, capture_scope, capture_key)
);
CREATE INDEX team_task_intents_instance ON team_task_intents(instance_id, created_at);
CREATE TABLE team_review_batches (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES team_task_intents(task_id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE TABLE team_review_claims (
  comment_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES team_review_batches(id) ON DELETE CASCADE
);
CREATE TABLE team_task_admissions (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES team_task_intents(task_id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  review_batch_id TEXT REFERENCES team_review_batches(id),
  source_admission_id TEXT REFERENCES team_task_admissions(id),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(instance_id, request_key)
);
CREATE INDEX team_task_admissions_task ON team_task_admissions(task_id, created_at);
CREATE TABLE team_task_admission_routes (
  admission_id TEXT NOT NULL REFERENCES team_task_admissions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  message_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('manager','assignee')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(admission_id, sequence),
  UNIQUE(admission_id, execution_id, actor_id, role)
);
CREATE INDEX team_task_routes_execution ON team_task_admission_routes(execution_id, actor_id);

-- JSON intent references outlive mutable task documents. Do not let an
-- individual deletion detach surviving parent/dependency or routing history.
CREATE TRIGGER team_task_referenced_delete BEFORE DELETE ON tasks
WHEN EXISTS (
  SELECT 1 FROM team_task_intents intent
    JOIN orchestration_team_instances i ON i.id=intent.instance_id
    JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
  WHERE json_extract(intent.payload,'$.parentTaskId')=OLD.id
    OR EXISTS (SELECT 1 FROM json_each(intent.payload,'$.dependencyTaskIds') dependency WHERE dependency.value=OLD.id)
) BEGIN SELECT RAISE(ABORT,'This task is referenced by retained team task history.'); END;
CREATE TRIGGER team_task_execution_retained_delete BEFORE DELETE ON team_executions
WHEN EXISTS (
  SELECT 1 FROM team_task_admission_routes r JOIN team_task_admissions a ON a.id=r.admission_id
    JOIN orchestration_team_instances i ON i.id=a.instance_id
    JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
  WHERE r.execution_id=OLD.id
) OR EXISTS (
  SELECT 1 FROM team_task_intents intent JOIN orchestration_team_instances i ON i.id=intent.instance_id
    JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
  WHERE json_extract(intent.payload,'$.origin.executionId')=OLD.id
) OR EXISTS (
  SELECT 1 FROM team_task_admissions a JOIN orchestration_team_instances i ON i.id=a.instance_id
    JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
  WHERE json_extract(a.payload,'$.source.executionId')=OLD.id
) BEGIN SELECT RAISE(ABORT,'This execution is referenced by retained team task history.'); END;
CREATE TRIGGER team_task_snapshot_retained_delete BEFORE DELETE ON snapshots
WHEN EXISTS (
  SELECT 1 FROM team_review_batches b JOIN tasks t ON t.id=b.task_id
    JOIN orchestration_team_instances i ON i.id=b.instance_id
    JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id,
    json_each(b.payload,'$.comments') c
  WHERE json_extract(c.value,'$.snapshotId')=OLD.id
) OR EXISTS (
  SELECT 1 FROM team_task_admissions a JOIN tasks t ON t.id=a.task_id
    JOIN orchestration_team_instances i ON i.id=a.instance_id
    JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
  WHERE json_extract(a.payload,'$.source.snapshotId')=OLD.id
) BEGIN SELECT RAISE(ABORT,'This snapshot is referenced by retained team task history.'); END;

CREATE TRIGGER team_task_intent_payload BEFORE INSERT ON team_task_intents
WHEN json_extract(NEW.payload,'$.taskId') IS NOT NEW.task_id
  OR json_extract(NEW.payload,'$.instanceId') IS NOT NEW.instance_id
  OR json_extract(NEW.payload,'$.teamRevisionId') IS NOT NEW.revision_id
  OR json_extract(NEW.payload,'$.capture.scope') IS NOT NEW.capture_scope
  OR json_extract(NEW.payload,'$.capture.requestKey') IS NOT NEW.capture_key
  OR json_extract(NEW.payload,'$.createdAt') IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT,'Team task intent payload does not match its indexed identity.'); END;
CREATE TRIGGER team_review_batch_payload BEFORE INSERT ON team_review_batches
WHEN json_extract(NEW.payload,'$.id') IS NOT NEW.id
  OR json_extract(NEW.payload,'$.taskId') IS NOT NEW.task_id
  OR json_extract(NEW.payload,'$.instanceId') IS NOT NEW.instance_id
  OR json_extract(NEW.payload,'$.createdAt') IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT,'Team review batch payload does not match its indexed identity.'); END;
CREATE TRIGGER team_task_admission_payload BEFORE INSERT ON team_task_admissions
WHEN json_extract(NEW.payload,'$.id') IS NOT NEW.id
  OR json_extract(NEW.payload,'$.taskId') IS NOT NEW.task_id
  OR json_extract(NEW.payload,'$.instanceId') IS NOT NEW.instance_id
  OR json_extract(NEW.payload,'$.requestKey') IS NOT NEW.request_key
  OR json_extract(NEW.payload,'$.reviewBatchId') IS NOT NEW.review_batch_id
  OR json_extract(NEW.payload,'$.sourceAdmissionId') IS NOT NEW.source_admission_id
  OR json_extract(NEW.payload,'$.createdAt') IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT,'Team task admission payload does not match its indexed identity.'); END;
CREATE TRIGGER team_task_route_sequence BEFORE INSERT ON team_task_admission_routes
WHEN NEW.sequence <> COALESCE((SELECT MAX(sequence) + 1 FROM team_task_admission_routes WHERE admission_id=NEW.admission_id),1)
BEGIN SELECT RAISE(ABORT,'Team admission routes must append in sequence.'); END;

CREATE TRIGGER team_task_intent_owner BEFORE INSERT ON team_task_intents
WHEN NOT EXISTS (
  SELECT 1 FROM tasks t JOIN threads h ON h.id=t.thread_id
  JOIN orchestration_team_instances i ON i.thread_id=h.id
  JOIN orchestration_team_revisions r ON r.id=i.team_revision_id
  WHERE t.id=NEW.task_id AND i.id=NEW.instance_id AND r.id=NEW.revision_id
    AND r.project_id=t.project_id AND h.project_id=t.project_id
) BEGIN SELECT RAISE(ABORT,'Team task intent ownership does not match.'); END;
CREATE TRIGGER team_review_batch_owner BEFORE INSERT ON team_review_batches
WHEN NOT EXISTS (SELECT 1 FROM team_task_intents WHERE task_id=NEW.task_id AND instance_id=NEW.instance_id)
BEGIN SELECT RAISE(ABORT,'Team review batch ownership does not match.'); END;
CREATE TRIGGER team_review_claim_owner BEFORE INSERT ON team_review_claims
WHEN NOT EXISTS (
  SELECT 1 FROM team_review_batches b, json_each(b.payload,'$.comments') c
  WHERE b.id=NEW.batch_id AND json_extract(c.value,'$.id')=NEW.comment_id
) BEGIN SELECT RAISE(ABORT,'Review claim must belong to its immutable batch.'); END;
CREATE TRIGGER team_task_admission_owner BEFORE INSERT ON team_task_admissions
WHEN NOT EXISTS (SELECT 1 FROM team_task_intents WHERE task_id=NEW.task_id AND instance_id=NEW.instance_id)
  OR (NEW.review_batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_review_batches b WHERE b.id=NEW.review_batch_id AND b.task_id=NEW.task_id AND b.instance_id=NEW.instance_id))
  OR (NEW.source_admission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_task_admissions a WHERE a.id=NEW.source_admission_id AND a.task_id=NEW.task_id AND a.instance_id=NEW.instance_id))
BEGIN SELECT RAISE(ABORT,'Team task admission ownership does not match.'); END;
CREATE TRIGGER team_task_route_owner BEFORE INSERT ON team_task_admission_routes
WHEN NOT EXISTS (
  SELECT 1 FROM team_task_admissions a JOIN team_executions e ON e.instance_id=a.instance_id,
    json_each(e.payload,'$.actors') actor
  WHERE a.id=NEW.admission_id AND e.id=NEW.execution_id AND json_extract(actor.value,'$.id')=NEW.actor_id
    AND (NEW.role='manager' OR json_extract(actor.value,'$.taskId')=a.task_id OR NEW.actor_id='lead')
    AND (NEW.message_id IS NULL OR EXISTS (
      SELECT 1 FROM json_each(e.payload,'$.messages') m WHERE json_extract(m.value,'$.id')=NEW.message_id
        AND json_extract(m.value,'$.recipientId')=NEW.actor_id AND json_extract(m.value,'$.kind')='direction'))
) BEGIN SELECT RAISE(ABORT,'Team admission route must belong to its instance and actor.'); END;

${["team_task_intents", "team_review_batches", "team_task_admissions", "team_task_admission_routes", "team_review_claims"]
  .map(
    (table) => `
CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT,'Team task admission history is immutable.'); END;
`,
  )
  .join("")}
CREATE TRIGGER team_task_intents_retained_delete BEFORE DELETE ON team_task_intents
WHEN EXISTS(SELECT 1 FROM tasks WHERE id=OLD.task_id) AND EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id=OLD.instance_id)
BEGIN SELECT RAISE(ABORT,'Team task intent is retained with its owner.'); END;
CREATE TRIGGER team_review_batches_retained_delete BEFORE DELETE ON team_review_batches
WHEN EXISTS(SELECT 1 FROM team_task_intents WHERE task_id=OLD.task_id) AND EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id=OLD.instance_id)
BEGIN SELECT RAISE(ABORT,'Team review batches are retained with their owner.'); END;
CREATE TRIGGER team_task_admissions_retained_delete BEFORE DELETE ON team_task_admissions
WHEN EXISTS(SELECT 1 FROM team_task_intents WHERE task_id=OLD.task_id) AND EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id=OLD.instance_id)
BEGIN SELECT RAISE(ABORT,'Team task admissions are retained with their owner.'); END;
CREATE TRIGGER team_task_routes_retained_delete BEFORE DELETE ON team_task_admission_routes
WHEN EXISTS(SELECT 1 FROM team_task_admissions WHERE id=OLD.admission_id) AND EXISTS(SELECT 1 FROM team_executions WHERE id=OLD.execution_id)
BEGIN SELECT RAISE(ABORT,'Team admission routing history is retained with its owner.'); END;
CREATE TRIGGER team_review_claims_retained_delete BEFORE DELETE ON team_review_claims
WHEN EXISTS(SELECT 1 FROM team_review_batches WHERE id=OLD.batch_id)
BEGIN SELECT RAISE(ABORT,'Team review claims are retained with their batch.'); END;
`;
