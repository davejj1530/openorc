/** Saved targets and durable launch receipts, including legacy single-model schedules. */
export const scheduleMigration = `
ALTER TABLE schedules ADD COLUMN execution_target TEXT CHECK(execution_target IS NULL OR json_valid(execution_target));
ALTER TABLE schedules ADD COLUMN team_revision_id TEXT REFERENCES orchestration_team_revisions(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE schedules ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
${["INSERT", "UPDATE OF execution_target, team_revision_id, project_id"]
  .map(
    (operation, index) => `
CREATE TRIGGER schedule_target_owner_${index} BEFORE ${operation} ON schedules
WHEN (NEW.team_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM orchestration_team_revisions r WHERE r.id=NEW.team_revision_id
    AND r.project_id=NEW.project_id AND r.sealed=1
    AND json_extract(NEW.execution_target,'$.kind')='team'
    AND json_extract(NEW.execution_target,'$.teamRevisionId')=r.id
)) OR (NEW.team_revision_id IS NULL AND json_extract(NEW.execution_target,'$.kind')='team')
BEGIN SELECT RAISE(ABORT,'Scheduled teams must pin a sealed revision in their project.'); END;
`,
  )
  .join("")}
CREATE TABLE schedule_firings (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 300),
  schedule_version INTEGER NOT NULL CHECK(schedule_version > 0),
  trigger TEXT NOT NULL CHECK(trigger IN ('timer','manual')),
  scheduled_for INTEGER,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  state TEXT NOT NULL CHECK(state IN ('pending','started','skipped','failed','cancelled')),
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  execution_id TEXT REFERENCES team_executions(id) ON DELETE SET NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(schedule_id, request_key),
  CHECK((state='pending' AND finished_at IS NULL) OR (state<>'pending' AND finished_at IS NOT NULL))
);
CREATE INDEX schedule_firings_pending ON schedule_firings(state,created_at);
CREATE INDEX schedule_firings_schedule ON schedule_firings(schedule_id,created_at);
CREATE TRIGGER schedule_firing_immutable BEFORE UPDATE ON schedule_firings
WHEN NEW.id<>OLD.id OR NEW.schedule_id<>OLD.schedule_id OR NEW.request_key<>OLD.request_key
  OR NEW.schedule_version<>OLD.schedule_version OR NEW.trigger<>OLD.trigger
  OR NEW.scheduled_for IS NOT OLD.scheduled_for OR NEW.snapshot<>OLD.snapshot
  OR NEW.created_at<>OLD.created_at
  OR (OLD.state<>'pending' AND (NEW.state<>OLD.state OR NEW.reason IS NOT OLD.reason
      OR NEW.finished_at IS NOT OLD.finished_at
      OR (NEW.thread_id IS NOT OLD.thread_id AND NEW.thread_id IS NOT NULL)
      OR (NEW.execution_id IS NOT OLD.execution_id AND NEW.execution_id IS NOT NULL)))
BEGIN SELECT RAISE(ABORT,'Schedule launch receipts are immutable after settlement.'); END;
CREATE TRIGGER schedule_firing_detach BEFORE UPDATE OF thread_id,execution_id ON schedule_firings
WHEN (OLD.thread_id IS NOT NULL AND NEW.thread_id IS NULL
    AND EXISTS(SELECT 1 FROM threads WHERE id=OLD.thread_id))
  OR (OLD.execution_id IS NOT NULL AND NEW.execution_id IS NULL
    AND EXISTS(SELECT 1 FROM team_executions WHERE id=OLD.execution_id))
BEGIN SELECT RAISE(ABORT,'Schedule launch ownership is retained until its owner is deleted.'); END;
${["INSERT", "UPDATE OF thread_id,execution_id"]
  .map(
    (operation, index) => `
CREATE TRIGGER schedule_firing_owner_${index} BEFORE ${operation} ON schedule_firings
WHEN (NEW.thread_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.project_id=json_extract(NEW.snapshot,'$.projectId')
)) OR (NEW.execution_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM team_executions e WHERE e.id=NEW.execution_id AND e.thread_id=NEW.thread_id
)${
      index === 1
        ? ` AND NOT (NEW.thread_id IS NULL AND OLD.thread_id IS NOT NULL
  AND NEW.execution_id=OLD.execution_id
  AND NOT EXISTS(SELECT 1 FROM threads WHERE id=OLD.thread_id))`
        : ""
    })
BEGIN SELECT RAISE(ABORT,'Schedule launch must belong to its captured project and thread.'); END;
`,
  )
  .join("")}
CREATE TRIGGER schedule_firing_retained BEFORE DELETE ON schedule_firings
WHEN EXISTS(SELECT 1 FROM schedules WHERE id=OLD.schedule_id)
BEGIN SELECT RAISE(ABORT,'Schedule launch receipts are retained with their schedule.'); END;
`;

export const teamNotificationMigration = `
CREATE TABLE team_notification_receipts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER team_notification_immutable BEFORE UPDATE ON team_notification_receipts
BEGIN SELECT RAISE(ABORT,'Notification receipts are immutable.'); END;
CREATE TRIGGER team_notification_retained BEFORE DELETE ON team_notification_receipts
WHEN EXISTS(SELECT 1 FROM team_executions WHERE id=OLD.execution_id)
BEGIN SELECT RAISE(ABORT,'Notification receipts are retained with their execution.'); END;
`;
