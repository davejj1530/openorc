/**
 * The columns a project keeps on its board, in order. A task remembers the column it was put in; a column that goes
 * leaves its tasks in their status.
 */
export const boardColumnsMigration = `
CREATE TABLE board_columns (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 stage TEXT NOT NULL CHECK (stage IN ('backlog', 'in_progress', 'review', 'done')),
 position INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX board_columns_project ON board_columns(project_id, position);
ALTER TABLE tasks ADD COLUMN column_id TEXT REFERENCES board_columns(id) ON DELETE SET NULL;
`;

/** The job a column starts for a card put in it, which is one of its project's task buttons, and the column that job hands the card on to. */
export const boardColumnJobsMigration = `
ALTER TABLE board_columns ADD COLUMN job_button_id TEXT;
ALTER TABLE board_columns ADD COLUMN next_column_id TEXT REFERENCES board_columns(id) ON DELETE SET NULL;
`;

/** A column's job can be switched off without forgetting it. */
export const boardColumnJobSwitchMigration = `ALTER TABLE board_columns ADD COLUMN job_enabled INTEGER NOT NULL DEFAULT 1 CHECK (job_enabled IN (0, 1));`;
