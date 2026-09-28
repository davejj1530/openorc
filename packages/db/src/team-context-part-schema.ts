/**
 * Verbatim history that no longer fits a 64 KiB context seed is stored here
 * unchanged, addressed by content hash, and read back by id during a turn. A
 * seed then carries references instead of silently dropping requirements.
 */
export const teamContextPartMigration = `
CREATE TABLE team_context_parts (
  instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes=length(CAST(content AS BLOB))),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(instance_id,id)
);
CREATE TRIGGER team_context_part_immutable BEFORE UPDATE ON team_context_parts
BEGIN SELECT RAISE(ABORT,'Stored context text is immutable.'); END;
CREATE TRIGGER team_context_part_retained BEFORE DELETE ON team_context_parts
WHEN EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id=OLD.instance_id)
BEGIN SELECT RAISE(ABORT,'Stored context text is retained with its instance.'); END;
`;
