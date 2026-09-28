/**
 * A team execution's journal as rows: one per actor, turn, mailbox message and file claim, beside the execution
 * row that keeps the execution's own fields. Columns hold what queries, constraints and triggers read; each row's
 * remaining fields stay together in `details`. A turn's full prompt lives apart, read only when the turn starts.
 * Existing journals move over unchanged, and every trigger that read the old JSON document reads the rows instead.
 * Any change to an execution's rows advances its row_version, so a copy read earlier can tell it is stale.
 */
export const teamJournalMigration = `
ALTER TABLE team_executions ADD COLUMN error TEXT;
ALTER TABLE team_executions ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE team_executions ADD COLUMN limits TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(limits) AND json_type(limits)='object');
ALTER TABLE team_executions ADD COLUMN admission_scope TEXT CHECK(admission_scope IS NULL OR admission_scope IN ('project','thread'));
ALTER TABLE team_executions ADD COLUMN admission_request_key TEXT CHECK(admission_request_key IS NULL OR length(admission_request_key) BETWEEN 1 AND 200);
ALTER TABLE team_executions ADD COLUMN admission_payload_hash TEXT;
ALTER TABLE team_executions ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0 CHECK(row_version>=0);
UPDATE team_executions SET
  error=json_extract(payload,'$.error'),
  deadline_at=json_extract(payload,'$.deadlineAt'),
  limits=json_extract(payload,'$.limits'),
  admission_scope=json_extract(payload,'$.admission.scope'),
  admission_request_key=json_extract(payload,'$.admission.requestKey'),
  admission_payload_hash=json_extract(payload,'$.admission.payloadHash');
CREATE INDEX team_executions_thread ON team_executions(thread_id, created_at);
CREATE INDEX team_executions_admission ON team_executions(admission_scope, admission_request_key) WHERE admission_request_key IS NOT NULL;

CREATE TABLE team_actors (
  execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id)>0),
  position INTEGER NOT NULL CHECK(position>=0),
  member_key TEXT NOT NULL CHECK(length(member_key)>0),
  task_id TEXT,
  parent_id TEXT,
  participant INTEGER NOT NULL CHECK(participant IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('queued','starting','running','waiting','attention','completed','cancelled')),
  details TEXT NOT NULL CHECK(json_valid(details) AND json_type(details)='object'),
  PRIMARY KEY(execution_id,id),
  UNIQUE(execution_id,position)
);
CREATE INDEX team_actors_task ON team_actors(task_id) WHERE task_id IS NOT NULL;
INSERT INTO team_actors(execution_id,id,position,member_key,task_id,parent_id,participant,state,details)
SELECT e.id, json_extract(a.value,'$.id'), a.key, json_extract(a.value,'$.memberKey'), json_extract(a.value,'$.taskId'),
  json_extract(a.value,'$.parentId'), COALESCE(json_extract(a.value,'$.participant'),0), json_extract(a.value,'$.state'),
  json_remove(a.value,'$.id','$.memberKey','$.taskId','$.parentId','$.participant','$.state')
FROM team_executions e, json_each(e.payload,'$.actors') a;

CREATE TABLE team_attempts (
  execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id)>0),
  position INTEGER NOT NULL CHECK(position>=0),
  actor_id TEXT NOT NULL,
  run_id TEXT,
  generation INTEGER NOT NULL CHECK(generation>0),
  state TEXT NOT NULL CHECK(state IN ('starting','running','closed','attention','cancelled')),
  snapshot_id TEXT,
  context_checkpoint_id TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  ended_at INTEGER,
  details TEXT NOT NULL CHECK(json_valid(details) AND json_type(details)='object'),
  PRIMARY KEY(execution_id,id),
  UNIQUE(execution_id,position),
  FOREIGN KEY(execution_id,actor_id) REFERENCES team_actors(execution_id,id) ON DELETE CASCADE
);
CREATE INDEX team_attempts_actor ON team_attempts(execution_id,actor_id,position);
CREATE INDEX team_attempts_run ON team_attempts(run_id) WHERE run_id IS NOT NULL;
INSERT INTO team_attempts(execution_id,id,position,actor_id,run_id,generation,state,snapshot_id,context_checkpoint_id,created_at,ended_at,details)
SELECT e.id, json_extract(a.value,'$.id'), a.key, json_extract(a.value,'$.actorId'), json_extract(a.value,'$.runId'),
  json_extract(a.value,'$.generation'), json_extract(a.value,'$.state'), json_extract(a.value,'$.snapshotId'),
  json_extract(a.value,'$.contextCheckpointId'), json_extract(a.value,'$.createdAt'), json_extract(a.value,'$.endedAt'),
  json_remove(a.value,'$.id','$.actorId','$.runId','$.generation','$.state','$.snapshotId','$.contextCheckpointId','$.createdAt','$.endedAt','$.prompt')
FROM team_executions e, json_each(e.payload,'$.attempts') a;

CREATE TABLE team_attempt_prompts (
  execution_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  PRIMARY KEY(execution_id,attempt_id),
  FOREIGN KEY(execution_id,attempt_id) REFERENCES team_attempts(execution_id,id) ON DELETE CASCADE
);
CREATE TRIGGER team_attempt_prompt_immutable BEFORE UPDATE ON team_attempt_prompts
BEGIN SELECT RAISE(ABORT,'A reserved turn prompt is immutable.'); END;
INSERT INTO team_attempt_prompts(execution_id,attempt_id,prompt)
SELECT e.id, json_extract(a.value,'$.id'), json_extract(a.value,'$.prompt')
FROM team_executions e, json_each(e.payload,'$.attempts') a WHERE json_type(a.value,'$.prompt')='text';

CREATE TABLE team_messages (
  execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id)>0),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  sender_id TEXT NOT NULL CHECK(length(sender_id)>0),
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('direction','result','chat')),
  dedupe_key TEXT NOT NULL CHECK(length(dedupe_key)>0),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','delivered','cancelled')),
  attempt_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  details TEXT NOT NULL CHECK(json_valid(details) AND json_type(details)='object'),
  PRIMARY KEY(execution_id,id),
  UNIQUE(execution_id,sequence),
  UNIQUE(execution_id,dedupe_key),
  FOREIGN KEY(execution_id,recipient_id) REFERENCES team_actors(execution_id,id) ON DELETE CASCADE,
  FOREIGN KEY(execution_id,attempt_id) REFERENCES team_attempts(execution_id,id) ON DELETE CASCADE
);
INSERT INTO team_messages(execution_id,id,sequence,sender_id,recipient_id,kind,dedupe_key,state,attempt_id,body,created_at,details)
SELECT e.id, json_extract(m.value,'$.id'), json_extract(m.value,'$.sequence'), json_extract(m.value,'$.senderId'),
  json_extract(m.value,'$.recipientId'), json_extract(m.value,'$.kind'), json_extract(m.value,'$.dedupeKey'),
  json_extract(m.value,'$.state'), json_extract(m.value,'$.attemptId'), json_extract(m.value,'$.body'), json_extract(m.value,'$.createdAt'),
  json_remove(m.value,'$.id','$.sequence','$.senderId','$.recipientId','$.kind','$.dedupeKey','$.state','$.attemptId','$.body','$.createdAt')
FROM team_executions e, json_each(e.payload,'$.messages') m;

CREATE TABLE team_claims (
  execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id)>0),
  position INTEGER NOT NULL CHECK(position>=0),
  actor_id TEXT NOT NULL,
  path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 4096),
  note TEXT CHECK(note IS NULL OR length(note)<=2000),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  released_at INTEGER CHECK(released_at IS NULL OR released_at>=created_at),
  PRIMARY KEY(execution_id,id),
  UNIQUE(execution_id,position),
  FOREIGN KEY(execution_id,actor_id) REFERENCES team_actors(execution_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX team_claims_active_path ON team_claims(execution_id,path) WHERE released_at IS NULL;
INSERT INTO team_claims(execution_id,id,position,actor_id,path,note,created_at,released_at)
SELECT e.id, json_extract(c.value,'$.id'), c.key, json_extract(c.value,'$.actorId'), json_extract(c.value,'$.path'),
  json_extract(c.value,'$.note'), json_extract(c.value,'$.createdAt'), json_extract(c.value,'$.releasedAt')
FROM team_executions e, json_each(e.payload,'$.claims') c;

DROP TRIGGER team_context_actor_insert;
CREATE TRIGGER team_context_actor_insert BEFORE INSERT ON team_context_checkpoints
  WHEN NEW.origin_execution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_executions e JOIN team_actors actor ON actor.execution_id=e.id
    WHERE e.id=NEW.origin_execution_id AND e.instance_id=NEW.instance_id AND actor.id=NEW.actor_id
      AND (NEW.actor_id='lead' OR EXISTS (
        SELECT 1 FROM team_assignment_bindings b
        WHERE b.execution_id=e.id AND b.actor_id=NEW.actor_id AND b.task_id=actor.task_id
      ))
  ) BEGIN
    SELECT RAISE(ABORT, 'Context actor must belong to its originating execution.');
  END;

DROP TRIGGER team_task_route_owner;
CREATE TRIGGER team_task_route_owner BEFORE INSERT ON team_task_admission_routes
WHEN NOT EXISTS (
  SELECT 1 FROM team_task_admissions a JOIN team_executions e ON e.instance_id=a.instance_id
    JOIN team_actors actor ON actor.execution_id=e.id
  WHERE a.id=NEW.admission_id AND e.id=NEW.execution_id AND actor.id=NEW.actor_id
    AND (NEW.role='manager' OR actor.task_id=a.task_id OR NEW.actor_id='lead')
    AND (NEW.message_id IS NULL OR EXISTS (
      SELECT 1 FROM team_messages m WHERE m.execution_id=e.id AND m.id=NEW.message_id
        AND m.recipient_id=NEW.actor_id AND m.kind='direction'))
) BEGIN SELECT RAISE(ABORT,'Team admission route must belong to its instance and actor.'); END;

DROP TRIGGER team_task_initial_lead_assignee;
CREATE TRIGGER team_task_initial_lead_assignee BEFORE INSERT ON team_task_admission_routes
  WHEN NEW.actor_id='lead' AND NEW.role='assignee' AND NEW.message_id IS NULL AND EXISTS (
    SELECT 1 FROM team_attempts attempt WHERE attempt.execution_id=NEW.execution_id AND attempt.actor_id='lead'
  ) BEGIN SELECT RAISE(ABORT,'A lead assignee route after reservation requires queued direction.'); END;

DROP TRIGGER team_task_completion_intent_owner;
CREATE TRIGGER team_task_completion_intent_owner BEFORE INSERT ON team_task_completion_intents
  WHEN NOT EXISTS (
    SELECT 1 FROM team_task_admissions a JOIN team_task_admission_routes r ON r.admission_id=a.id
      JOIN team_executions e ON e.id=r.execution_id AND e.instance_id=a.instance_id
      JOIN team_attempts attempt ON attempt.execution_id=e.id
    WHERE a.id=NEW.admission_id AND r.execution_id=NEW.execution_id AND r.actor_id='lead' AND r.role='assignee'
      AND attempt.id=NEW.attempt_id AND attempt.actor_id='lead'
  ) BEGIN SELECT RAISE(ABORT,'Task completion intent must belong to its lead assignment and attempt.'); END;

DROP TRIGGER team_task_completion_owner;
CREATE TRIGGER team_task_completion_owner BEFORE INSERT ON team_task_completions
  WHEN NOT EXISTS (
    SELECT 1 FROM team_task_completion_intents i JOIN team_task_admissions a ON a.id=i.admission_id
      JOIN team_executions e ON e.id=i.execution_id JOIN runs run ON run.id=NEW.run_id
      JOIN snapshots s ON s.id=NEW.snapshot_id
      JOIN team_attempts attempt ON attempt.execution_id=e.id AND attempt.id=NEW.attempt_id
    WHERE i.admission_id=NEW.admission_id AND i.attempt_id=NEW.attempt_id
      AND i.execution_id=NEW.execution_id AND i.actor_id=NEW.actor_id AND i.result=NEW.result
      AND attempt.actor_id='lead' AND attempt.run_id=run.id AND attempt.state='closed'
      AND run.thread_id=e.thread_id AND run.task_id IS NULL AND run.state='success' AND run.ended_at IS NOT NULL
      AND s.task_id=a.task_id AND s.run_id=run.id
  ) BEGIN SELECT RAISE(ABORT,'Task completion must retain its successful lead run, intent, and task snapshot.'); END;

DROP TRIGGER team_task_completion_run_retained;
CREATE TRIGGER team_task_completion_run_retained BEFORE DELETE ON runs
  WHEN EXISTS (
    SELECT 1 FROM team_task_completion_intents c JOIN team_task_admissions a ON a.id=c.admission_id
      JOIN tasks t ON t.id=a.task_id JOIN orchestration_team_instances i ON i.id=a.instance_id
      JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
      JOIN team_attempts attempt ON attempt.execution_id=c.execution_id AND attempt.id=c.attempt_id
    WHERE attempt.run_id=OLD.id
  ) BEGIN SELECT RAISE(ABORT,'This run is referenced by retained task completion history.'); END;

DROP TRIGGER team_restore_owner;
CREATE TRIGGER team_restore_owner BEFORE INSERT ON team_restores
WHEN NEW.state<>'pending' OR NEW.paths<>'[]' OR NEW.applied_path IS NOT NULL OR NEW.applied_context_id IS NOT NULL OR NEW.error IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM orchestration_team_instances i JOIN threads t ON t.id=i.thread_id JOIN projects p ON p.id=t.project_id
      JOIN thread_checkpoints c ON c.thread_id=t.id
    WHERE i.id=NEW.instance_id AND t.id=NEW.thread_id AND p.id=NEW.project_id
      AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot')
      AND ((t.workspace_mode='worktree' AND t.worktree_path=json_extract(NEW.captured_input,'$.sourcePath'))
        OR (t.workspace_mode='current' AND t.worktree_path IS NULL AND p.root_path=json_extract(NEW.captured_input,'$.sourcePath')))
      AND c.id=json_extract(NEW.captured_input,'$.checkpointId') AND c.tree_sha=json_extract(NEW.captured_input,'$.targetTree')
  ) OR (json_extract(NEW.captured_input,'$.sourceRunId') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_run_bindings b JOIN team_executions e ON e.id=b.execution_id JOIN runs r ON r.id=b.run_id
      JOIN team_attempts a ON a.execution_id=e.id AND a.id=b.attempt_id
    WHERE b.run_id=json_extract(NEW.captured_input,'$.sourceRunId') AND b.actor_id='lead' AND e.instance_id=NEW.instance_id
      AND e.thread_id=NEW.thread_id AND e.project_id=NEW.project_id AND r.thread_id=NEW.thread_id AND r.task_id IS NULL
      AND a.actor_id='lead' AND a.run_id=b.run_id AND a.snapshot_id=json_extract(NEW.captured_input,'$.checkpointId')
  ))
BEGIN SELECT RAISE(ABORT,'Restore intent must capture its current team workspace and exact owned checkpoint.'); END;

DROP TRIGGER team_deleted_thread_admission;
CREATE TRIGGER team_deleted_thread_admission BEFORE INSERT ON team_executions
WHEN EXISTS (SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.thread_id)
  AND NOT EXISTS (
    SELECT 1 FROM team_task_admissions a JOIN tasks x ON x.id=a.task_id
    WHERE a.instance_id=NEW.instance_id AND x.thread_id=NEW.thread_id
      AND NEW.admission_scope='thread' AND NEW.admission_request_key='task:'||a.id)
BEGIN SELECT RAISE(ABORT,'A deleted conversation only runs through an accepted request of one of its saved tasks.'); END;

DROP TRIGGER team_context_part_retained;
CREATE TRIGGER team_context_part_retained BEFORE DELETE ON team_context_parts
WHEN EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id=OLD.instance_id) AND (
  EXISTS(SELECT 1 FROM team_context_checkpoints c WHERE c.instance_id=OLD.instance_id AND instr(c.seed,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_origins o WHERE o.instance_id=OLD.instance_id AND instr(o.seed,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_forks f WHERE f.source_instance_id=OLD.instance_id AND instr(f.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_restores r WHERE r.instance_id=OLD.instance_id AND instr(r.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_moves m WHERE m.instance_id=OLD.instance_id AND instr(m.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_deletions d WHERE d.instance_id=OLD.instance_id AND instr(d.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_executions e WHERE e.instance_id=OLD.instance_id AND instr(COALESCE(e.error,''),OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_executions e JOIN team_actors x ON x.execution_id=e.id WHERE e.instance_id=OLD.instance_id AND instr(x.details,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_executions e JOIN team_attempts x ON x.execution_id=e.id WHERE e.instance_id=OLD.instance_id AND instr(x.details,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_executions e JOIN team_attempt_prompts x ON x.execution_id=e.id WHERE e.instance_id=OLD.instance_id AND instr(x.prompt,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_executions e JOIN team_messages x ON x.execution_id=e.id WHERE e.instance_id=OLD.instance_id AND (instr(x.body,OLD.id)>0 OR instr(x.details,OLD.id)>0))
  OR EXISTS(SELECT 1 FROM team_executions e JOIN team_claims x ON x.execution_id=e.id WHERE e.instance_id=OLD.instance_id AND (instr(x.path,OLD.id)>0 OR instr(COALESCE(x.note,''),OLD.id)>0))
  OR EXISTS(SELECT 1 FROM team_context_parts p WHERE p.instance_id=OLD.instance_id AND p.id<>OLD.id AND instr(p.content,OLD.id)>0))
BEGIN SELECT RAISE(ABORT,'Stored context text is still referenced by its instance.'); END;

CREATE TRIGGER team_actors_inserted AFTER INSERT ON team_actors BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_actors_updated AFTER UPDATE ON team_actors BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_actors_deleted AFTER DELETE ON team_actors BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=OLD.execution_id; END;
CREATE TRIGGER team_attempts_inserted AFTER INSERT ON team_attempts BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_attempts_updated AFTER UPDATE ON team_attempts BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_attempts_deleted AFTER DELETE ON team_attempts BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=OLD.execution_id; END;
CREATE TRIGGER team_messages_inserted AFTER INSERT ON team_messages BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_messages_updated AFTER UPDATE ON team_messages BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_messages_deleted AFTER DELETE ON team_messages BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=OLD.execution_id; END;
CREATE TRIGGER team_claims_inserted AFTER INSERT ON team_claims BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_claims_updated AFTER UPDATE ON team_claims BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=NEW.execution_id; END;
CREATE TRIGGER team_claims_deleted AFTER DELETE ON team_claims BEGIN UPDATE team_executions SET row_version=row_version+1 WHERE id=OLD.execution_id; END;

ALTER TABLE team_executions DROP COLUMN payload;
`;
