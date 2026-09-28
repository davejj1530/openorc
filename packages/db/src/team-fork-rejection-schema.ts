/** A rejected request stays rejected even after its source or blocking condition changes. */
export const teamForkRejectionMigration = `
CREATE TABLE team_fork_rejections (
  source_thread_id TEXT NOT NULL CHECK(length(source_thread_id)>0),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  error TEXT NOT NULL CHECK(length(error)>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(source_thread_id,request_key)
);
CREATE TRIGGER team_fork_rejected BEFORE INSERT ON team_forks
WHEN EXISTS(SELECT 1 FROM team_fork_rejections r WHERE r.source_thread_id=NEW.source_thread_id AND r.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'This fork request was rejected and cannot later be admitted.'); END;
CREATE TRIGGER team_fork_rejection_admitted BEFORE INSERT ON team_fork_rejections
WHEN EXISTS(SELECT 1 FROM team_forks f WHERE f.source_thread_id=NEW.source_thread_id AND f.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'An admitted fork request cannot be rejected.'); END;
CREATE TRIGGER team_fork_rejection_immutable BEFORE UPDATE ON team_fork_rejections
BEGIN SELECT RAISE(ABORT,'Fork rejection receipts are immutable.'); END;
CREATE TRIGGER team_fork_rejection_retained BEFORE DELETE ON team_fork_rejections
BEGIN SELECT RAISE(ABORT,'Fork rejection receipts are retained independently of their owners.'); END;
`;
