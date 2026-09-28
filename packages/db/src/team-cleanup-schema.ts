/**
 * A hidden owner's saved tasks can be deleted together: that final receipt lists
 * them as deleted, removes the owner's remaining workspaces through the same
 * journal, and applies only once the owner row and those tasks are gone.
 * Stored context text becomes removable once nothing in its instance refers to it.
 */
export const teamCleanupMigration = `
DROP TRIGGER team_deletion_owner;
CREATE TRIGGER team_deletion_owner BEFORE INSERT ON team_deletions
WHEN NEW.state<>'pending' OR NEW.applied_context_id IS NOT NULL OR NEW.error IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM orchestration_team_instances i JOIN threads t ON t.id=i.thread_id JOIN projects p ON p.id=t.project_id
    WHERE i.id=NEW.instance_id AND t.id=NEW.thread_id AND p.id=NEW.project_id AND p.root_path=json_extract(NEW.captured_input,'$.projectRoot'))
  OR (EXISTS (SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.thread_id)
    AND (json_array_length(NEW.captured_input,'$.retainedTaskIds')>0 OR COALESCE(json_array_length(NEW.captured_input,'$.deletedTaskIds'),0)=0))
  OR (NOT EXISTS (SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.thread_id)
    AND COALESCE(json_array_length(NEW.captured_input,'$.deletedTaskIds'),0)>0)
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.deletedTaskIds') r WHERE r.type<>'text'
    OR NOT EXISTS (SELECT 1 FROM tasks x WHERE x.id=r.value AND x.thread_id=NEW.thread_id))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.deletedTaskIds') a JOIN json_each(NEW.captured_input,'$.deletedTaskIds') b ON a.key<b.key AND a.value=b.value)
  OR EXISTS (SELECT 1 FROM tasks x WHERE x.thread_id=NEW.thread_id
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.retainedTaskIds') r WHERE r.value=x.id)
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.deletedTaskIds') r WHERE r.value=x.id))
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
    ON x.worktree_path IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath'))
    WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.deletedTaskIds') d WHERE d.value=x.id))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_workspaces w JOIN team_executions x ON x.id=w.execution_id
    WHERE x.instance_id<>NEW.instance_id AND json_extract(w.payload,'$.path') IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_forks f, json_each(f.paths) p
    WHERE f.destination_thread_id<>NEW.thread_id AND p.value IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_restores r, json_each(r.paths) p
    WHERE r.thread_id<>NEW.thread_id AND p.value IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.entries') e, team_moves m, json_each(m.paths) p
    WHERE m.thread_id<>NEW.thread_id AND json_extract(p.value,'$.path') IN (json_extract(e.value,'$.path'), json_extract(e.value,'$.canonicalPath')))
BEGIN SELECT RAISE(ABORT,'Deletion intent must capture its exact owner, every saved task as retained or deleted, the execution boundary and only owned workspaces.'); END;
DROP TRIGGER team_deletion_applied;
CREATE TRIGGER team_deletion_applied BEFORE UPDATE ON team_deletions
WHEN NEW.state='applied' AND OLD.state<>'applied' AND (
  (SELECT COUNT(*) FROM team_deletion_items i WHERE i.deletion_id=NEW.id)<>json_array_length(NEW.captured_input,'$.entries')
  OR EXISTS (SELECT 1 FROM team_deletion_items i WHERE i.deletion_id=NEW.id AND i.state<>'removed')
  OR (json_array_length(NEW.captured_input,'$.retainedTaskIds')>0 AND NOT EXISTS (
    SELECT 1 FROM team_deleted_threads d WHERE d.thread_id=NEW.thread_id AND d.instance_id=NEW.instance_id
      AND d.context_checkpoint_id=NEW.applied_context_id
      AND d.through_execution_rowid=json_extract(NEW.captured_input,'$.throughExecutionRowid')))
  OR (json_array_length(NEW.captured_input,'$.retainedTaskIds')=0 AND (NEW.applied_context_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id)
    OR EXISTS (SELECT 1 FROM json_each(NEW.captured_input,'$.deletedTaskIds') d JOIN tasks x ON x.id=d.value))))
BEGIN SELECT RAISE(ABORT,'Applied deletion must confirm every cleanup item and either its hidden owner marker or the absent owner and its deleted tasks.'); END;
DROP TRIGGER team_context_part_retained;
CREATE TRIGGER team_context_part_retained BEFORE DELETE ON team_context_parts
WHEN EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id=OLD.instance_id) AND (
  EXISTS(SELECT 1 FROM team_context_checkpoints c WHERE c.instance_id=OLD.instance_id AND instr(c.seed,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_origins o WHERE o.instance_id=OLD.instance_id AND instr(o.seed,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_forks f WHERE f.source_instance_id=OLD.instance_id AND instr(f.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_restores r WHERE r.instance_id=OLD.instance_id AND instr(r.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_moves m WHERE m.instance_id=OLD.instance_id AND instr(m.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_deletions d WHERE d.instance_id=OLD.instance_id AND instr(d.captured_input,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_executions e WHERE e.instance_id=OLD.instance_id AND instr(e.payload,OLD.id)>0)
  OR EXISTS(SELECT 1 FROM team_context_parts p WHERE p.instance_id=OLD.instance_id AND p.id<>OLD.id AND instr(p.content,OLD.id)>0))
BEGIN SELECT RAISE(ABORT,'Stored context text is still referenced by its instance.'); END;
`;
