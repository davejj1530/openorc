export const claudeAccountMigration = `
CREATE TABLE claude_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cli','managed')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL
);
INSERT INTO claude_accounts VALUES ('claude-cli', 'Existing CLI login', 'cli', 1, 0);
ALTER TABLE threads ADD COLUMN claude_account_id TEXT REFERENCES claude_accounts(id);
ALTER TABLE runs ADD COLUMN claude_account_id TEXT REFERENCES claude_accounts(id);
UPDATE threads SET claude_account_id = 'claude-cli';
UPDATE runs SET claude_account_id = 'claude-cli' WHERE agent = 'claude';
ALTER TABLE schedules ADD COLUMN claude_account_id TEXT REFERENCES claude_accounts(id);
UPDATE schedules SET claude_account_id = 'claude-cli';
CREATE INDEX runs_claude_account ON runs(claude_account_id, started_at) WHERE agent = 'claude';
`;
