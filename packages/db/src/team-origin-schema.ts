import { MAX_TEAM_CONTEXT_BYTES } from "@openorc/protocol";

/** Fork provenance is descriptive; only the destination owns the retained context. */
export const teamOriginMigration = `
CREATE TABLE team_origins (
  instance_id TEXT PRIMARY KEY REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  source_thread_id TEXT NOT NULL CHECK(length(source_thread_id)>0),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)>0 AND source_instance_id<>instance_id),
  source_run_id TEXT CHECK(source_run_id IS NULL OR length(source_run_id)>0),
  seed TEXT NOT NULL CHECK(length(CAST(seed AS BLOB)) BETWEEN 1 AND ${MAX_TEAM_CONTEXT_BYTES}),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE TRIGGER team_origin_owner BEFORE INSERT ON team_origins
WHEN NOT EXISTS (
  SELECT 1 FROM orchestration_team_instances target JOIN orchestration_team_instances source
    ON source.project_id=target.project_id
  WHERE target.id=NEW.instance_id AND source.id=NEW.source_instance_id AND source.thread_id=NEW.source_thread_id
) OR (NEW.source_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM team_run_bindings b JOIN team_executions e ON e.id=b.execution_id
    JOIN runs r ON r.id=b.run_id
  WHERE r.id=NEW.source_run_id AND b.actor_id='lead' AND e.instance_id=NEW.source_instance_id
    AND r.thread_id=NEW.source_thread_id AND r.task_id IS NULL
))
BEGIN SELECT RAISE(ABORT,'Fork context must originate from its project and source lead.'); END;
CREATE TRIGGER team_origin_immutable BEFORE UPDATE ON team_origins
BEGIN SELECT RAISE(ABORT,'Fork origins are immutable.'); END;
CREATE TRIGGER team_origin_retained BEFORE DELETE ON team_origins
WHEN EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id=OLD.instance_id)
BEGIN SELECT RAISE(ABORT,'Fork context is retained with its destination instance.'); END;
`;
