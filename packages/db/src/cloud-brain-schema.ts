import { relocationMigrations } from "./relocation-schema.js";

/**
 * Project memories this ledger removed, so the copy the cloud brain or the Mac keeps drops them too and never brings
 * them back. Made only where missing, as the relocation journal is.
 */
export const memoryTombstoneMigration = `
CREATE TABLE IF NOT EXISTS memory_tombstones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  removed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_tombstones_project ON memory_tombstones(project_id, removed_at);
`;

/** What the Mac and its cloud brain keep about each other's work, in order. */
export const cloudBrainMigrations = [...relocationMigrations, memoryTombstoneMigration];
