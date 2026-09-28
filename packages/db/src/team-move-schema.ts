import { MAX_TEAM_CONTEXT_BYTES } from "@openorc/protocol";

/** Move manifests retain every candidate and publication plan independently of deleted owners. */
export const teamMoveMigration = `
CREATE TABLE team_moves (
  id TEXT PRIMARY KEY CHECK(length(id)>0),
  thread_id TEXT NOT NULL CHECK(length(thread_id)>0),
  instance_id TEXT NOT NULL CHECK(length(instance_id)>0),
  project_id TEXT NOT NULL CHECK(length(project_id)>0),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  captured_input TEXT NOT NULL CHECK(json_valid(captured_input)),
  state TEXT NOT NULL CHECK(state IN ('pending','attention','applied','cancelled')),
  paths TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(paths) AND json_type(paths)='array'),
  publication TEXT CHECK(publication IS NULL OR json_valid(publication)),
  after_tree TEXT CHECK(after_tree IS NULL OR (length(after_tree) IN (40,64) AND after_tree NOT GLOB '*[^0-9a-f]*')),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  applied_path TEXT,
  applied_context_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  UNIQUE(thread_id,request_key),
  CHECK((publication IS NULL AND after_tree IS NULL) OR (publication IS NOT NULL AND after_tree IS NOT NULL)),
  CHECK((state='applied' AND applied_path IS NOT NULL AND applied_context_id IS NOT NULL AND error IS NULL AND cancel_requested=0 AND publication IS NOT NULL)
    OR (state='cancelled' AND applied_path IS NULL AND applied_context_id IS NULL AND error IS NULL AND cancel_requested=1)
    OR (state='pending' AND applied_path IS NULL AND applied_context_id IS NULL AND error IS NULL)
    OR (state='attention' AND applied_path IS NULL AND applied_context_id IS NULL AND error IS NOT NULL AND length(error)>0)),
  CHECK(json_type(captured_input,'$.seed') IS 'text' AND length(CAST(json_extract(captured_input,'$.seed') AS BLOB)) BETWEEN 1 AND ${MAX_TEAM_CONTEXT_BYTES}),
  CHECK(json_type(captured_input,'$.from') IS 'text' AND json_type(captured_input,'$.to') IS 'text'
    AND json_extract(captured_input,'$.from') IN ('current','worktree') AND json_extract(captured_input,'$.to') IN ('current','worktree')
    AND json_extract(captured_input,'$.from')<>json_extract(captured_input,'$.to')),
  CHECK((json_extract(captured_input,'$.to')='current' AND json_type(captured_input,'$.destinationBefore') IS 'object' AND json_type(captured_input,'$.originMoveId') IS 'null')
    OR (json_extract(captured_input,'$.to')='worktree' AND json_type(captured_input,'$.destinationBefore') IS 'null' AND json_type(captured_input,'$.originMoveId') IS 'text')),
  CHECK(json_type(captured_input,'$.deltas') IS 'array' AND json_array_length(captured_input,'$.deltas')<=1000)
);
CREATE INDEX team_moves_thread_state ON team_moves(thread_id,state);
CREATE UNIQUE INDEX team_moves_one_open_per_thread ON team_moves(thread_id) WHERE state IN ('pending','attention');
CREATE TRIGGER team_move_owner BEFORE INSERT ON team_moves
WHEN NEW.state<>'pending' OR NEW.paths<>'[]' OR NEW.publication IS NOT NULL OR NEW.after_tree IS NOT NULL OR NEW.cancel_requested<>0
  OR NEW.applied_path IS NOT NULL OR NEW.applied_context_id IS NOT NULL OR NEW.error IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM orchestration_team_instances i JOIN threads t ON t.id=i.thread_id JOIN projects p ON p.id=t.project_id
    WHERE i.id=NEW.instance_id AND t.id=NEW.thread_id AND p.id=NEW.project_id
      AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot')
      AND t.workspace_mode=json_extract(NEW.captured_input,'$.from')
      AND ((t.workspace_mode='worktree' AND t.worktree_path=json_extract(NEW.captured_input,'$.sourcePath'))
        OR (t.workspace_mode='current' AND t.worktree_path IS NULL AND p.root_path=json_extract(NEW.captured_input,'$.sourcePath')))
  ) OR (json_extract(NEW.captured_input,'$.from')='current' AND NOT EXISTS (
    SELECT 1 FROM team_moves origin WHERE origin.id=json_extract(NEW.captured_input,'$.originMoveId')
      AND origin.thread_id=NEW.thread_id AND origin.instance_id=NEW.instance_id AND origin.project_id=NEW.project_id
      AND origin.state='applied' AND json_extract(origin.captured_input,'$.to')='current'
      AND origin.id=(SELECT m.id FROM team_moves m LEFT JOIN team_context_checkpoints c ON c.id=m.applied_context_id
        WHERE m.thread_id=NEW.thread_id AND m.state='applied' ORDER BY c.epoch DESC,m.updated_at DESC,m.rowid DESC LIMIT 1)
  ))
BEGIN SELECT RAISE(ABORT,'Move intent must capture its current team, source pointer and latest owned return origin.'); END;
CREATE TRIGGER team_move_immutable BEFORE UPDATE ON team_moves
WHEN NEW.id<>OLD.id OR NEW.thread_id<>OLD.thread_id OR NEW.instance_id<>OLD.instance_id OR NEW.project_id<>OLD.project_id
  OR NEW.request_key<>OLD.request_key OR NEW.request_hash<>OLD.request_hash OR NEW.captured_input<>OLD.captured_input
  OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at OR (OLD.state='attention' AND NEW.state='pending')
  OR NEW.cancel_requested<OLD.cancel_requested OR (OLD.cancel_requested=1 AND NEW.state='applied')
  OR (OLD.state IN ('applied','cancelled') AND (NEW.state<>OLD.state OR NEW.paths<>OLD.paths OR NEW.publication IS NOT OLD.publication
    OR NEW.after_tree IS NOT OLD.after_tree OR NEW.cancel_requested<>OLD.cancel_requested OR NEW.applied_path IS NOT OLD.applied_path
    OR NEW.applied_context_id IS NOT OLD.applied_context_id OR NEW.error IS NOT OLD.error OR NEW.updated_at<>OLD.updated_at))
  OR (OLD.publication IS NOT NULL AND (NEW.publication IS NOT OLD.publication OR NEW.after_tree IS NOT OLD.after_tree))
  OR (OLD.cancel_requested=1 AND OLD.publication IS NULL AND NEW.publication IS NOT NULL)
  OR json_array_length(NEW.paths)<json_array_length(OLD.paths) OR json_array_length(NEW.paths)>json_array_length(OLD.paths)+1
  OR EXISTS(SELECT 1 FROM json_each(OLD.paths) p WHERE json_extract(NEW.paths,'$['||p.key||']') IS NOT p.value)
  OR EXISTS(SELECT 1 FROM json_each(NEW.paths) p WHERE json_type(p.value,'$.path') IS NOT 'text' OR json_extract(p.value,'$.path') NOT LIKE '/%'
    OR json_extract(p.value,'$.path')=json_extract(NEW.captured_input,'$.sourcePath') OR json_extract(p.value,'$.path')=json_extract(NEW.captured_input,'$.projectRoot')
    OR json_type(p.value,'$.kind') IS NOT 'text' OR json_extract(p.value,'$.kind') NOT IN ('scratch','workspace')
    OR (json_extract(p.value,'$.kind')='workspace' AND (json_extract(NEW.captured_input,'$.to')<>'worktree' OR (NEW.cancel_requested=1 AND p.key>=json_array_length(OLD.paths)))))
  OR EXISTS(SELECT 1 FROM json_each(NEW.paths) a JOIN json_each(NEW.paths) b ON a.key<b.key AND json_extract(a.value,'$.path')=json_extract(b.value,'$.path'))
  OR EXISTS(SELECT 1 FROM team_moves m,json_each(m.paths) p,json_each(NEW.paths) n WHERE m.id<>OLD.id AND json_extract(p.value,'$.path')=json_extract(n.value,'$.path'))
BEGIN SELECT RAISE(ABORT,'Move inputs, terminal outcomes and publication plans are immutable; recovery appends a new path.'); END;
CREATE TRIGGER team_move_publication BEFORE UPDATE ON team_moves
WHEN NEW.publication IS NOT NULL AND (
  json_type(NEW.publication,'$.entries') IS NOT 'array' OR json_array_length(NEW.publication,'$.entries')>100000
  OR json_type(NEW.publication,'$.afterTree') IS NOT 'text' OR length(json_extract(NEW.publication,'$.afterTree')) NOT IN (40,64)
  OR json_extract(NEW.publication,'$.afterTree') GLOB '*[^0-9a-f]*'
  OR NEW.after_tree IS NOT CASE json_extract(NEW.captured_input,'$.to') WHEN 'current' THEN json_extract(NEW.publication,'$.afterTree') ELSE json_extract(NEW.captured_input,'$.source.treeSha') END
  OR EXISTS(SELECT 1 FROM json_each(NEW.publication,'$.entries') entry WHERE json_type(entry.value,'$.path') IS NOT 'text'
    OR json_type(entry.value,'$.before') IS NULL OR json_type(entry.value,'$.before') NOT IN ('null','object')
    OR json_type(entry.value,'$.after') IS NULL OR json_type(entry.value,'$.after') NOT IN ('null','object')
    OR (json_type(entry.value,'$.before') IS 'null' AND json_type(entry.value,'$.after') IS 'null')
    OR (json_type(entry.value,'$.before') IS 'object' AND json_extract(entry.value,'$.before.path') IS NOT json_extract(entry.value,'$.path'))
    OR (json_type(entry.value,'$.after') IS 'object' AND json_extract(entry.value,'$.after.path') IS NOT json_extract(entry.value,'$.path')))
  OR EXISTS(SELECT 1 FROM json_each(NEW.publication,'$.entries') a JOIN json_each(NEW.publication,'$.entries') b
    ON a.key<b.key AND json_extract(a.value,'$.path')=json_extract(b.value,'$.path'))
)
BEGIN SELECT RAISE(ABORT,'Move publication must retain unique exact paths and the correct result tree.'); END;
CREATE TRIGGER team_move_applied_owner BEFORE UPDATE ON team_moves
WHEN NEW.state='applied' AND OLD.state<>'applied' AND (
  NEW.publication IS NULL OR NEW.cancel_requested<>0 OR NOT EXISTS (
    SELECT 1 FROM threads t JOIN orchestration_team_instances i ON i.thread_id=t.id JOIN projects p ON p.id=t.project_id
      JOIN team_context_checkpoints c ON c.instance_id=i.id
    WHERE t.id=NEW.thread_id AND t.project_id=NEW.project_id AND i.id=NEW.instance_id
      AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot') AND t.workspace_mode=json_extract(NEW.captured_input,'$.to')
      AND t.branch IS json_extract(NEW.captured_input,'$.publicationBranch')
      AND ((t.workspace_mode='current' AND t.worktree_path IS NULL AND NEW.applied_path=p.root_path AND t.base_sha=json_extract(NEW.captured_input,'$.destinationBefore.headSha'))
        OR (t.workspace_mode='worktree' AND t.worktree_path=NEW.applied_path AND t.base_sha=json_extract(NEW.captured_input,'$.source.headSha')
          AND NEW.applied_path=(SELECT json_extract(candidate.value,'$.path') FROM json_each(NEW.paths) candidate WHERE json_extract(candidate.value,'$.kind')='workspace' ORDER BY candidate.key DESC LIMIT 1)))
      AND c.id=NEW.applied_context_id AND c.execution_id IS NULL AND c.actor_id='lead' AND c.origin_execution_id IS NULL
      AND c.reason='compact' AND c.request_key='move:'||NEW.id AND c.seed=json_extract(NEW.captured_input,'$.seed')
  ))
BEGIN SELECT RAISE(ABORT,'Applied move must retain its exact owned pointer, HEAD, branch and replacement context.'); END;
CREATE TRIGGER team_move_cancelled_owner BEFORE UPDATE ON team_moves
WHEN NEW.state='cancelled' AND OLD.state<>'cancelled' AND (OLD.cancel_requested<>1 OR NOT EXISTS (
  SELECT 1 FROM threads t JOIN orchestration_team_instances i ON i.thread_id=t.id JOIN projects p ON p.id=t.project_id
  WHERE t.id=NEW.thread_id AND i.id=NEW.instance_id AND p.id=NEW.project_id AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot')
    AND t.workspace_mode=json_extract(NEW.captured_input,'$.from')
    AND ((t.workspace_mode='current' AND t.worktree_path IS NULL AND p.root_path=json_extract(NEW.captured_input,'$.sourcePath'))
      OR (t.workspace_mode='worktree' AND t.worktree_path=json_extract(NEW.captured_input,'$.sourcePath')))
))
BEGIN SELECT RAISE(ABORT,'Cancelled move must preserve its original pointer after explicit cancellation.'); END;
CREATE TRIGGER team_move_retained BEFORE DELETE ON team_moves
BEGIN SELECT RAISE(ABORT,'Move recovery manifests are retained independently of their owners.'); END;
CREATE TABLE team_move_rejections (
  thread_id TEXT NOT NULL CHECK(length(thread_id)>0), request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  error TEXT NOT NULL CHECK(length(error)>0), created_at INTEGER NOT NULL CHECK(created_at>=0), PRIMARY KEY(thread_id,request_key)
);
CREATE TRIGGER team_move_rejected BEFORE INSERT ON team_moves
WHEN EXISTS(SELECT 1 FROM team_move_rejections r WHERE r.thread_id=NEW.thread_id AND r.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'This move request was rejected and cannot later be admitted.'); END;
CREATE TRIGGER team_move_rejection_admitted BEFORE INSERT ON team_move_rejections
WHEN EXISTS(SELECT 1 FROM team_moves m WHERE m.thread_id=NEW.thread_id AND m.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'An admitted move request cannot be rejected.'); END;
CREATE TRIGGER team_move_rejection_immutable BEFORE UPDATE ON team_move_rejections
BEGIN SELECT RAISE(ABORT,'Move rejection receipts are immutable.'); END;
CREATE TRIGGER team_move_rejection_retained BEFORE DELETE ON team_move_rejections
BEGIN SELECT RAISE(ABORT,'Move rejection receipts are retained independently of their owners.'); END;
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
    SELECT 1 FROM team_run_bindings b JOIN team_executions e ON e.id=b.execution_id JOIN runs r ON r.id=b.run_id,
      json_each(e.payload,'$.attempts') a
    WHERE b.run_id=json_extract(NEW.captured_input,'$.sourceRunId') AND b.actor_id='lead' AND e.instance_id=NEW.instance_id
      AND e.thread_id=NEW.thread_id AND e.project_id=NEW.project_id AND r.thread_id=NEW.thread_id AND r.task_id IS NULL
      AND json_extract(a.value,'$.id')=b.attempt_id AND json_extract(a.value,'$.actorId')='lead'
      AND json_extract(a.value,'$.runId')=b.run_id AND json_extract(a.value,'$.snapshotId')=json_extract(NEW.captured_input,'$.checkpointId')
  ))
BEGIN SELECT RAISE(ABORT,'Restore intent must capture its current team workspace and exact owned checkpoint.'); END;
`;
