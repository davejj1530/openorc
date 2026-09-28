import { MAX_TEAM_CONTEXT_BYTES } from "@openorc/protocol";

/**
 * Deleting a team conversation either hides its owner behind an immutable marker
 * (saved tasks survive with their team) or removes only proven owned workspaces
 * through a journaled cleanup. Receipts outlive their owners so a lost response
 * can never repeat cleanup against later or recreated paths.
 */
export const teamDeleteMigration = `
CREATE TABLE team_deletions (
  id TEXT PRIMARY KEY CHECK(length(id)>0),
  thread_id TEXT NOT NULL CHECK(length(thread_id)>0),
  instance_id TEXT NOT NULL CHECK(length(instance_id)>0),
  project_id TEXT NOT NULL CHECK(length(project_id)>0),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  captured_input TEXT NOT NULL CHECK(json_valid(captured_input)),
  state TEXT NOT NULL CHECK(state IN ('pending','attention','applied')),
  applied_context_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  UNIQUE(thread_id,request_key),
  CHECK((state='applied' AND error IS NULL)
    OR (state='pending' AND applied_context_id IS NULL AND error IS NULL)
    OR (state='attention' AND applied_context_id IS NULL AND error IS NOT NULL AND length(error)>0)),
  CHECK(json_type(captured_input,'$.projectRoot')='text' AND json_extract(captured_input,'$.projectRoot') LIKE '/%'
    AND json_type(captured_input,'$.retainedTaskIds')='array' AND json_array_length(captured_input,'$.retainedTaskIds')<=10000
    AND json_type(captured_input,'$.entries')='array' AND json_array_length(captured_input,'$.entries')<=10000
    AND json_type(captured_input,'$.retainedPaths')='array' AND json_array_length(captured_input,'$.retainedPaths')<=100000
    AND json_type(captured_input,'$.throughExecutionRowid')='integer' AND json_extract(captured_input,'$.throughExecutionRowid')>=0),
  CHECK((json_array_length(captured_input,'$.retainedTaskIds')>0 AND json_array_length(captured_input,'$.entries')=0
      AND json_type(captured_input,'$.seed')='text' AND length(CAST(json_extract(captured_input,'$.seed') AS BLOB)) BETWEEN 1 AND ${MAX_TEAM_CONTEXT_BYTES})
    OR (json_array_length(captured_input,'$.retainedTaskIds')=0 AND json_type(captured_input,'$.seed')='null')),
  CHECK(state<>'applied' OR (json_array_length(captured_input,'$.retainedTaskIds')>0)=(applied_context_id IS NOT NULL))
);
CREATE INDEX team_deletions_thread_state ON team_deletions(thread_id,state);
CREATE UNIQUE INDEX team_deletions_one_open_per_thread ON team_deletions(thread_id) WHERE state<>'applied';
CREATE TRIGGER team_deletion_owner BEFORE INSERT ON team_deletions
WHEN NEW.state<>'pending' OR NEW.applied_context_id IS NOT NULL OR NEW.error IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM orchestration_team_instances i JOIN threads t ON t.id=i.thread_id JOIN projects p ON p.id=t.project_id
    WHERE i.id=NEW.instance_id AND t.id=NEW.thread_id AND p.id=NEW.project_id AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot'))
  OR EXISTS (SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.thread_id)
  OR EXISTS (SELECT 1 FROM tasks x WHERE x.thread_id=NEW.thread_id
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.retainedTaskIds') r WHERE r.value=x.id))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.retainedTaskIds') r WHERE r.type<>'text'
    OR NOT EXISTS (SELECT 1 FROM tasks x WHERE x.id=r.value AND x.thread_id=NEW.thread_id))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.retainedTaskIds') a JOIN json_each(NEW.captured_input,'$.retainedTaskIds') b ON a.key<b.key AND a.value=b.value)
  OR json_extract(NEW.captured_input,'$.throughExecutionRowid')<>(SELECT COALESCE(MAX(rowid),0) FROM team_executions e WHERE e.thread_id=NEW.thread_id)
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e
    WHERE json_type(e.value,'$.path')<>'text' OR json_extract(e.value,'$.path') NOT LIKE '/%'
      OR json_type(e.value,'$.canonicalPath')<>'text' OR json_extract(e.value,'$.canonicalPath') NOT LIKE '/%'
      OR json_type(e.value,'$.quarantinePath')<>'text' OR json_extract(e.value,'$.quarantinePath') NOT LIKE '/%'
      OR json_extract(e.value,'$.quarantinePath') IN (json_extract(e.value,'$.canonicalPath'), json_extract(e.value,'$.path')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e JOIN projects p
    ON p.root_path IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath'), json_extract(e.value,'$.quarantinePath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') a JOIN json_each(NEW.captured_input,'$.entries') b ON a.key<b.key
    AND (json_extract(a.value,'$.canonicalPath') IN (json_extract(b.value,'$.canonicalPath'), json_extract(b.value,'$.quarantinePath'))
      OR json_extract(a.value,'$.quarantinePath') IN (json_extract(b.value,'$.canonicalPath'), json_extract(b.value,'$.quarantinePath'))))
  OR EXISTS (SELECT 1 FROM team_deletions d, json_each(d.captured_input,'$.entries') o, json_each(NEW.captured_input,'$.entries') n
    WHERE json_extract(o.value,'$.canonicalPath') IN (json_extract(n.value,'$.canonicalPath'), json_extract(n.value,'$.quarantinePath'))
      OR json_extract(o.value,'$.quarantinePath') IN (json_extract(n.value,'$.canonicalPath'), json_extract(n.value,'$.quarantinePath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e JOIN threads t
    ON t.id<>NEW.thread_id AND t.worktree_path IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e JOIN tasks x
    ON x.worktree_path IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_workspaces w JOIN team_executions x ON x.id=w.execution_id
    WHERE x.instance_id<>NEW.instance_id AND json_extract(w.payload,'$.path') IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_forks f, json_each(f.paths) p
    WHERE f.destination_thread_id<>NEW.thread_id AND p.value IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_restores r, json_each(r.paths) p
    WHERE r.thread_id<>NEW.thread_id AND p.value IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_moves m, json_each(m.paths) p
    WHERE m.thread_id<>NEW.thread_id AND json_extract(p.value,'$.path') IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
BEGIN SELECT RAISE(ABORT,'Deletion intent must capture its exact owner, every saved task, the execution boundary and only owned workspaces.'); END;
CREATE TRIGGER team_deletion_immutable BEFORE UPDATE ON team_deletions
WHEN NEW.id<>OLD.id OR NEW.thread_id<>OLD.thread_id OR NEW.instance_id<>OLD.instance_id OR NEW.project_id<>OLD.project_id
  OR NEW.request_key<>OLD.request_key OR NEW.request_hash<>OLD.request_hash OR NEW.captured_input<>OLD.captured_input
  OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at OR (OLD.state='attention' AND NEW.state='pending')
  OR (OLD.state='applied' AND (NEW.state<>OLD.state OR NEW.applied_context_id IS NOT OLD.applied_context_id
    OR NEW.error IS NOT OLD.error OR NEW.updated_at<>OLD.updated_at))
BEGIN SELECT RAISE(ABORT,'Deletion intent is immutable; only its progress and outcome advance.'); END;
CREATE TRIGGER team_deletion_applied BEFORE UPDATE ON team_deletions
WHEN NEW.state='applied' AND OLD.state<>'applied' AND (
  (SELECT COUNT(*) FROM team_deletion_items i WHERE i.deletion_id=NEW.id)<>json_array_length(NEW.captured_input,'$.entries')
  OR EXISTS (SELECT 1 FROM team_deletion_items i WHERE i.deletion_id=NEW.id AND i.state<>'removed')
  OR (json_array_length(NEW.captured_input,'$.retainedTaskIds')>0 AND NOT EXISTS (
    SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.thread_id AND d.instance_id=NEW.instance_id
      AND d.context_checkpoint_id=NEW.applied_context_id
      AND d.through_execution_rowid=json_extract(NEW.captured_input,'$.throughExecutionRowid')))
  OR (json_array_length(NEW.captured_input,'$.retainedTaskIds')=0 AND (NEW.applied_context_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id))))
BEGIN SELECT RAISE(ABORT,'Applied deletion must confirm every cleanup item and either its hidden owner marker or the absent owner.'); END;
CREATE TRIGGER team_deletion_retained BEFORE DELETE ON team_deletions
BEGIN SELECT RAISE(ABORT,'Deletion receipts are retained independently of their owners.'); END;
CREATE TABLE team_deletion_items (
  deletion_id TEXT NOT NULL REFERENCES team_deletions(id),
  item_index INTEGER NOT NULL CHECK(item_index>=0),
  state TEXT NOT NULL CHECK(state IN ('pending','quarantined','removed')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(deletion_id,item_index)
);
CREATE TRIGGER team_deletion_item_owner BEFORE INSERT ON team_deletion_items
WHEN NEW.state<>'pending' OR NOT EXISTS (
  SELECT 1 FROM team_deletions d WHERE d.id=NEW.deletion_id AND d.state='pending'
    AND NEW.item_index<json_array_length(d.captured_input,'$.entries') AND NEW.updated_at>=d.created_at)
BEGIN SELECT RAISE(ABORT,'Cleanup items mirror the immutable inventory of a pending deletion.'); END;
CREATE TRIGGER team_deletion_item_progress BEFORE UPDATE ON team_deletion_items
WHEN NEW.deletion_id<>OLD.deletion_id OR NEW.item_index<>OLD.item_index OR NEW.updated_at<OLD.updated_at
  OR (OLD.state='removed' AND NEW.state<>'removed') OR (OLD.state='quarantined' AND NEW.state='pending')
  OR EXISTS (SELECT 1 FROM team_deletions d WHERE d.id=NEW.deletion_id AND d.state='applied')
BEGIN SELECT RAISE(ABORT,'Cleanup progress only advances from pending through quarantined to removed.'); END;
CREATE TRIGGER team_deletion_item_retained BEFORE DELETE ON team_deletion_items
BEGIN SELECT RAISE(ABORT,'Cleanup journals are retained with their receipts.'); END;
CREATE TABLE team_deleted_threads (
  thread_id TEXT PRIMARY KEY CHECK(length(thread_id)>0),
  instance_id TEXT NOT NULL CHECK(length(instance_id)>0),
  deleted_at INTEGER NOT NULL CHECK(deleted_at>=0),
  context_checkpoint_id TEXT NOT NULL CHECK(length(context_checkpoint_id)>0),
  through_execution_rowid INTEGER NOT NULL CHECK(through_execution_rowid>=0)
);
CREATE TRIGGER team_deleted_thread_owner BEFORE INSERT ON team_deleted_threads
WHEN NOT EXISTS (
  SELECT 1 FROM team_deletions d JOIN orchestration_team_instances i ON i.id=d.instance_id JOIN threads t ON t.id=i.thread_id
    JOIN team_context_checkpoints c ON c.instance_id=i.id
  WHERE d.thread_id=NEW.thread_id AND d.instance_id=NEW.instance_id AND t.id=NEW.thread_id AND d.state<>'applied'
    AND json_array_length(d.captured_input,'$.retainedTaskIds')>0
    AND json_extract(d.captured_input,'$.throughExecutionRowid')=NEW.through_execution_rowid
    AND NEW.through_execution_rowid=(SELECT COALESCE(MAX(rowid),0) FROM team_executions e WHERE e.thread_id=NEW.thread_id)
    AND c.id=NEW.context_checkpoint_id AND c.execution_id IS NULL AND c.actor_id='lead' AND c.origin_execution_id IS NULL
    AND c.reason='compact' AND c.request_key='delete:'||d.id AND c.seed=json_extract(d.captured_input,'$.seed')
    AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.thread_id=NEW.thread_id
      AND NOT EXISTS (SELECT 1 FROM json_each(d.captured_input,'$.retainedTaskIds') r WHERE r.value=x.id))
    AND NOT EXISTS (SELECT 1 FROM json_each(d.captured_input,'$.retainedTaskIds') r
      WHERE NOT EXISTS (SELECT 1 FROM tasks x WHERE x.id=r.value AND x.thread_id=NEW.thread_id))
    AND t.archived_at IS NULL AND t.done_at IS NULL AND t.snoozed_until IS NULL AND t.pinned_at IS NULL)
BEGIN SELECT RAISE(ABORT,'A hidden owner marker requires its pending deletion, exact surviving tasks and fresh task-only lead context.'); END;
CREATE TRIGGER team_deleted_thread_immutable BEFORE UPDATE ON team_deleted_threads
BEGIN SELECT RAISE(ABORT,'Hidden owner markers are immutable.'); END;
CREATE TRIGGER team_deleted_thread_retained BEFORE DELETE ON team_deleted_threads
BEGIN SELECT RAISE(ABORT,'Hidden owner markers are retained.'); END;
CREATE TRIGGER team_deleted_thread_flags BEFORE UPDATE OF archived_at,done_at,snoozed_until,pinned_at ON threads
WHEN EXISTS (SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.id)
  AND (NEW.archived_at IS NOT NULL OR NEW.done_at IS NOT NULL OR NEW.snoozed_until IS NOT NULL OR NEW.pinned_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'A deleted conversation cannot be organized; its saved tasks keep their team controls.'); END;
CREATE TRIGGER team_deleted_thread_admission BEFORE INSERT ON team_executions
WHEN EXISTS (SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.thread_id)
  AND NOT EXISTS (
    SELECT 1 FROM team_task_admissions a JOIN tasks x ON x.id=a.task_id
    WHERE a.instance_id=NEW.instance_id AND x.thread_id=NEW.thread_id
      AND json_extract(NEW.payload,'$.admission.scope')='thread' AND json_extract(NEW.payload,'$.admission.requestKey')='task:'||a.id)
BEGIN SELECT RAISE(ABORT,'A deleted conversation only runs through an accepted request of one of its saved tasks.'); END;
CREATE TRIGGER team_deletion_fences_executions BEFORE INSERT ON team_executions
WHEN EXISTS (SELECT 1 FROM team_deletions d WHERE d.thread_id=NEW.thread_id AND d.state<>'applied')
BEGIN SELECT RAISE(ABORT,'Finish or retry the retained deletion before starting new team work.'); END;
CREATE TRIGGER team_deletion_fences_admissions BEFORE INSERT ON team_task_admissions
WHEN EXISTS (SELECT 1 FROM team_deletions d WHERE d.instance_id=NEW.instance_id AND d.state<>'applied')
BEGIN SELECT RAISE(ABORT,'Finish or retry the retained deletion before accepting task work.'); END;
CREATE TRIGGER team_deletion_fences_context BEFORE INSERT ON team_context_checkpoints
WHEN EXISTS (SELECT 1 FROM team_deletions d WHERE d.instance_id=NEW.instance_id AND d.state<>'applied' AND NEW.request_key<>'delete:'||d.id)
BEGIN SELECT RAISE(ABORT,'Finish or retry the retained deletion before changing team context.'); END;
CREATE TRIGGER team_deletion_fences_forks BEFORE INSERT ON team_forks
WHEN EXISTS (SELECT 1 FROM team_deletions d WHERE d.thread_id=NEW.source_thread_id AND d.state<>'applied')
  OR EXISTS (SELECT 1 FROM team_deleted_threads h WHERE h.thread_id=NEW.source_thread_id)
BEGIN SELECT RAISE(ABORT,'A deleted or deleting conversation cannot be forked.'); END;
CREATE TRIGGER team_deletion_fences_restores BEFORE INSERT ON team_restores
WHEN EXISTS (SELECT 1 FROM team_deletions d WHERE d.thread_id=NEW.thread_id AND d.state<>'applied')
  OR EXISTS (SELECT 1 FROM team_deleted_threads h WHERE h.thread_id=NEW.thread_id)
BEGIN SELECT RAISE(ABORT,'A deleted or deleting conversation cannot restore a checkpoint.'); END;
CREATE TRIGGER team_deletion_fences_moves BEFORE INSERT ON team_moves
WHEN EXISTS (SELECT 1 FROM team_deletions d WHERE d.thread_id=NEW.thread_id AND d.state<>'applied')
  OR EXISTS (SELECT 1 FROM team_deleted_threads h WHERE h.thread_id=NEW.thread_id)
BEGIN SELECT RAISE(ABORT,'A deleted or deleting conversation cannot move its workspace.'); END;
CREATE TABLE team_deletion_rejections (
  thread_id TEXT NOT NULL CHECK(length(thread_id)>0),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  error TEXT NOT NULL CHECK(length(error)>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(thread_id,request_key)
);
CREATE TRIGGER team_deletion_rejected BEFORE INSERT ON team_deletions
WHEN EXISTS(SELECT 1 FROM team_deletion_rejections r WHERE r.thread_id=NEW.thread_id AND r.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'This deletion request was rejected and cannot later be admitted.'); END;
CREATE TRIGGER team_deletion_rejection_admitted BEFORE INSERT ON team_deletion_rejections
WHEN EXISTS(SELECT 1 FROM team_deletions d WHERE d.thread_id=NEW.thread_id AND d.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'An admitted deletion request cannot be rejected.'); END;
CREATE TRIGGER team_deletion_rejection_immutable BEFORE UPDATE ON team_deletion_rejections
BEGIN SELECT RAISE(ABORT,'Deletion rejection receipts are immutable.'); END;
CREATE TRIGGER team_deletion_rejection_retained BEFORE DELETE ON team_deletion_rejections
BEGIN SELECT RAISE(ABORT,'Deletion rejection receipts are retained independently of their owners.'); END;
`;
