import { MAX_TEAM_CONTEXT_BYTES } from "@openorc/protocol";

/** A restore can leave materialized directories behind even after its owner is deleted. */
export const teamRestoreMigration = `
CREATE TABLE team_restores (
  id TEXT PRIMARY KEY CHECK(length(id)>0),
  thread_id TEXT NOT NULL CHECK(length(thread_id)>0),
  instance_id TEXT NOT NULL CHECK(length(instance_id)>0),
  project_id TEXT NOT NULL CHECK(length(project_id)>0),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  captured_input TEXT NOT NULL CHECK(json_valid(captured_input)),
  state TEXT NOT NULL CHECK(state IN ('pending','attention','applied')),
  paths TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(paths) AND json_type(paths)='array'),
  applied_path TEXT,
  applied_context_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  UNIQUE(thread_id,request_key),
  CHECK((state='applied' AND applied_path IS NOT NULL AND applied_context_id IS NOT NULL AND error IS NULL)
    OR (state='pending' AND applied_path IS NULL AND applied_context_id IS NULL AND error IS NULL)
    OR (state='attention' AND applied_path IS NULL AND applied_context_id IS NULL AND error IS NOT NULL AND length(error)>0)),
  CHECK(json_type(captured_input,'$.seed') IS 'text'
    AND length(CAST(json_extract(captured_input,'$.seed') AS BLOB)) BETWEEN 1 AND ${MAX_TEAM_CONTEXT_BYTES})
);
CREATE INDEX team_restores_thread_state ON team_restores(thread_id,state);
CREATE TRIGGER team_restore_owner BEFORE INSERT ON team_restores
WHEN NEW.state<>'pending' OR NEW.paths<>'[]' OR NEW.applied_path IS NOT NULL OR NEW.applied_context_id IS NOT NULL OR NEW.error IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM orchestration_team_instances i JOIN threads t ON t.id=i.thread_id JOIN projects p ON p.id=t.project_id
      JOIN thread_checkpoints c ON c.thread_id=t.id
    WHERE i.id=NEW.instance_id AND t.id=NEW.thread_id AND p.id=NEW.project_id
      AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot')
      AND t.workspace_mode='worktree' AND t.worktree_path=json_extract(NEW.captured_input,'$.sourcePath')
      AND c.id=json_extract(NEW.captured_input,'$.checkpointId') AND c.tree_sha=json_extract(NEW.captured_input,'$.targetTree')
  ) OR (json_extract(NEW.captured_input,'$.sourceRunId') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_run_bindings b JOIN team_executions e ON e.id=b.execution_id JOIN runs r ON r.id=b.run_id,
      json_each(e.payload,'$.attempts') a
    WHERE b.run_id=json_extract(NEW.captured_input,'$.sourceRunId') AND b.actor_id='lead' AND e.instance_id=NEW.instance_id
      AND e.thread_id=NEW.thread_id AND e.project_id=NEW.project_id AND r.thread_id=NEW.thread_id AND r.task_id IS NULL
      AND json_extract(a.value,'$.id')=b.attempt_id AND json_extract(a.value,'$.actorId')='lead'
      AND json_extract(a.value,'$.runId')=b.run_id AND json_extract(a.value,'$.snapshotId')=json_extract(NEW.captured_input,'$.checkpointId')
  ))
BEGIN SELECT RAISE(ABORT,'Restore intent must capture its current team workspace and exact owned checkpoint.'); END;
CREATE TRIGGER team_restore_immutable BEFORE UPDATE ON team_restores
WHEN NEW.id<>OLD.id OR NEW.thread_id<>OLD.thread_id OR NEW.instance_id<>OLD.instance_id OR NEW.project_id<>OLD.project_id
  OR NEW.request_key<>OLD.request_key OR NEW.request_hash<>OLD.request_hash OR NEW.captured_input<>OLD.captured_input
  OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at OR (OLD.state='attention' AND NEW.state='pending')
  OR (OLD.state='applied' AND (NEW.state<>OLD.state OR NEW.paths<>OLD.paths OR NEW.applied_path IS NOT OLD.applied_path
    OR NEW.applied_context_id IS NOT OLD.applied_context_id OR NEW.error IS NOT OLD.error OR NEW.updated_at<>OLD.updated_at))
  OR json_array_length(NEW.paths)<json_array_length(OLD.paths) OR json_array_length(NEW.paths)>json_array_length(OLD.paths)+1
  OR EXISTS(SELECT 1 FROM json_each(OLD.paths) old WHERE json_extract(NEW.paths,'$['||old.key||']') IS NOT old.value)
  OR EXISTS(SELECT 1 FROM json_each(NEW.paths) p WHERE p.type<>'text' OR p.value NOT LIKE '/%'
    OR p.value=json_extract(NEW.captured_input,'$.sourcePath') OR p.value=json_extract(NEW.captured_input,'$.projectRoot'))
  OR EXISTS(SELECT 1 FROM json_each(NEW.paths) a JOIN json_each(NEW.paths) b ON a.key<b.key AND a.value=b.value)
  OR EXISTS(SELECT 1 FROM team_restores f,json_each(f.paths) p,json_each(NEW.paths) n WHERE f.id<>OLD.id AND p.value=n.value)
BEGIN SELECT RAISE(ABORT,'Restore inputs and candidate paths are immutable; recovery appends a new path.'); END;
CREATE TRIGGER team_restore_applied_owner BEFORE UPDATE ON team_restores
WHEN NEW.state='applied' AND OLD.state<>'applied' AND (
  NEW.applied_path IS NOT json_extract(NEW.paths,'$[#-1]') OR NOT EXISTS (
    SELECT 1 FROM threads t JOIN orchestration_team_instances i ON i.thread_id=t.id JOIN projects p ON p.id=t.project_id
      JOIN team_context_checkpoints c ON c.instance_id=i.id
    WHERE t.id=NEW.thread_id AND t.project_id=NEW.project_id AND i.id=NEW.instance_id
      AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot')
      AND t.workspace_mode='worktree' AND t.worktree_path=NEW.applied_path
      AND t.base_sha=json_extract(NEW.captured_input,'$.before.headSha')
      AND c.id=NEW.applied_context_id AND c.execution_id IS NULL AND c.actor_id='lead' AND c.origin_execution_id IS NULL
      AND c.reason='compact' AND c.request_key='restore:'||NEW.id AND c.seed=json_extract(NEW.captured_input,'$.seed')
  ))
BEGIN SELECT RAISE(ABORT,'Applied restore must retain its owned workspace, original HEAD and exact replacement context.'); END;
CREATE TRIGGER team_restore_retained BEFORE DELETE ON team_restores
BEGIN SELECT RAISE(ABORT,'Restore recovery manifests are retained independently of their owners.'); END;
CREATE TABLE team_restore_rejections (
  thread_id TEXT NOT NULL CHECK(length(thread_id)>0),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  error TEXT NOT NULL CHECK(length(error)>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(thread_id,request_key)
);
CREATE TRIGGER team_restore_rejected BEFORE INSERT ON team_restores
WHEN EXISTS(SELECT 1 FROM team_restore_rejections r WHERE r.thread_id=NEW.thread_id AND r.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'This restore request was rejected and cannot later be admitted.'); END;
CREATE TRIGGER team_restore_rejection_admitted BEFORE INSERT ON team_restore_rejections
WHEN EXISTS(SELECT 1 FROM team_restores r WHERE r.thread_id=NEW.thread_id AND r.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'An admitted restore request cannot be rejected.'); END;
CREATE TRIGGER team_restore_rejection_immutable BEFORE UPDATE ON team_restore_rejections
BEGIN SELECT RAISE(ABORT,'Restore rejection receipts are immutable.'); END;
CREATE TRIGGER team_restore_rejection_retained BEFORE DELETE ON team_restore_rejections
BEGIN SELECT RAISE(ABORT,'Restore rejection receipts are retained independently of their owners.'); END;
`;
