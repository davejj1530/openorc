import { MAX_TEAM_CONTEXT_BYTES } from "@openorc/protocol";

/** Independent of owner cascades: unfinished filesystem work must remain discoverable. */
export const teamForkMigration = `
CREATE TABLE team_forks (
  id TEXT PRIMARY KEY CHECK(length(id)>0),
  source_thread_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  destination_thread_id TEXT NOT NULL UNIQUE CHECK(length(destination_thread_id)>0),
  captured_input TEXT NOT NULL CHECK(json_valid(captured_input)),
  state TEXT NOT NULL CHECK(state IN ('pending','attention','applied')),
  paths TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(paths) AND json_type(paths)='array'),
  applied_path TEXT,
  error TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  UNIQUE(source_thread_id,request_key),
  CHECK((state='applied' AND applied_path IS NOT NULL AND error IS NULL)
    OR (state='pending' AND applied_path IS NULL AND error IS NULL)
    OR (state='attention' AND applied_path IS NULL AND error IS NOT NULL AND length(error)>0)),
  CHECK(json_type(captured_input,'$.seed') IS 'text'
    AND length(CAST(json_extract(captured_input,'$.seed') AS BLOB)) BETWEEN 1 AND ${MAX_TEAM_CONTEXT_BYTES})
);
CREATE INDEX team_forks_pending_source ON team_forks(source_thread_id,state);
CREATE TRIGGER team_fork_owner BEFORE INSERT ON team_forks
WHEN NEW.state<>'pending' OR NEW.paths<>'[]' OR NEW.applied_path IS NOT NULL OR NEW.error IS NOT NULL
  OR (json_extract(NEW.captured_input,'$.upToRunId') IS NOT NULL
    AND json_extract(NEW.captured_input,'$.upToRunId') IS NOT json_extract(NEW.captured_input,'$.sourceRunId'))
  OR EXISTS(SELECT 1 FROM threads WHERE id=NEW.destination_thread_id)
  OR NOT EXISTS (
    SELECT 1 FROM orchestration_team_instances i JOIN threads t ON t.id=i.thread_id JOIN projects p ON p.id=t.project_id
    WHERE i.id=NEW.source_instance_id AND t.id=NEW.source_thread_id AND p.id=NEW.project_id
      AND i.team_revision_id=json_extract(NEW.captured_input,'$.teamRevisionId')
      AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot')
  ) OR (json_extract(NEW.captured_input,'$.sourceRunId') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_run_bindings b JOIN team_executions e ON e.id=b.execution_id JOIN runs r ON r.id=b.run_id
    WHERE r.id=json_extract(NEW.captured_input,'$.sourceRunId') AND b.actor_id='lead'
      AND e.instance_id=NEW.source_instance_id AND r.thread_id=NEW.source_thread_id AND r.task_id IS NULL
  ))
BEGIN SELECT RAISE(ABORT,'Fork intent must capture its source team before creating the destination.'); END;
CREATE TRIGGER team_fork_immutable BEFORE UPDATE ON team_forks
WHEN NEW.id<>OLD.id OR NEW.source_thread_id<>OLD.source_thread_id OR NEW.source_instance_id<>OLD.source_instance_id
  OR NEW.project_id<>OLD.project_id OR NEW.request_key<>OLD.request_key OR NEW.request_hash<>OLD.request_hash
  OR NEW.destination_thread_id<>OLD.destination_thread_id OR NEW.captured_input<>OLD.captured_input OR NEW.created_at<>OLD.created_at
  OR NEW.updated_at<OLD.updated_at
  OR (OLD.state='applied' AND (NEW.state<>OLD.state OR NEW.paths<>OLD.paths OR NEW.applied_path IS NOT OLD.applied_path
    OR NEW.error IS NOT OLD.error OR NEW.updated_at<>OLD.updated_at))
  OR json_array_length(NEW.paths)<json_array_length(OLD.paths) OR json_array_length(NEW.paths)>json_array_length(OLD.paths)+1
  OR EXISTS(SELECT 1 FROM json_each(OLD.paths) old WHERE json_extract(NEW.paths,'$['||old.key||']') IS NOT old.value)
  OR EXISTS(SELECT 1 FROM json_each(NEW.paths) p WHERE p.type<>'text' OR length(p.value)=0)
  OR EXISTS(SELECT 1 FROM json_each(NEW.paths) a JOIN json_each(NEW.paths) b ON a.key<b.key AND a.value=b.value)
  OR EXISTS(SELECT 1 FROM team_forks f,json_each(f.paths) p,json_each(NEW.paths) n WHERE f.id<>OLD.id AND p.value=n.value)
BEGIN SELECT RAISE(ABORT,'Fork inputs and candidate paths are immutable; recovery appends a new path.'); END;
CREATE TRIGGER team_fork_applied_owner BEFORE UPDATE ON team_forks
WHEN NEW.state='applied' AND OLD.state<>'applied' AND (
  NEW.applied_path IS NOT json_extract(NEW.paths,'$[#-1]') OR NOT EXISTS (
    SELECT 1 FROM threads t JOIN orchestration_team_instances i ON i.thread_id=t.id JOIN team_origins o ON o.instance_id=i.id
    WHERE t.id=NEW.destination_thread_id AND t.project_id=NEW.project_id AND t.worktree_path=NEW.applied_path
      AND i.team_revision_id=json_extract(NEW.captured_input,'$.teamRevisionId')
      AND i.lead_overrides=json_extract(NEW.captured_input,'$.leadOverrides')
      AND t.agent=json_extract(NEW.captured_input,'$.thread.agent')
      AND t.model IS json_extract(NEW.captured_input,'$.thread.model')
      AND t.effort IS json_extract(NEW.captured_input,'$.thread.effort')
      AND t.fast_mode=json_extract(NEW.captured_input,'$.thread.fastMode')
      AND t.mode=json_extract(NEW.captured_input,'$.thread.mode')
      AND t.permission_mode=json_extract(NEW.captured_input,'$.thread.permissionMode')
      AND t.workspace_mode='worktree' AND t.branch IS NULL
      AND t.base_sha=json_extract(NEW.captured_input,'$.snapshot.headSha')
      AND o.source_thread_id=NEW.source_thread_id AND o.source_instance_id=NEW.source_instance_id
      AND o.source_run_id IS json_extract(NEW.captured_input,'$.sourceRunId')
      AND o.seed=json_extract(NEW.captured_input,'$.seed')
  ))
BEGIN SELECT RAISE(ABORT,'Applied fork must retain its new workspace, pinned instance and exact origin.'); END;
CREATE TRIGGER team_fork_retained BEFORE DELETE ON team_forks
BEGIN SELECT RAISE(ABORT,'Fork recovery manifests are retained independently of their owners.'); END;
`;
