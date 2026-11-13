import type { DatabaseSync } from "node:sqlite";

/**
 * A conversation whose agent runs in a cloud sandbox. Its worktree on the Mac mirrors the sandbox's checkout; the
 * mirror columns record what that worktree last matched, so the next sync sends only what is new.
 */
export const cloudWorkspaceMigration = `
CREATE TABLE cloud_workspaces (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('local', 'vercel')),
  sandbox TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'failed')),
  error TEXT,
  mirror_snapshot TEXT,
  mirror_tree TEXT,
  mirror_known TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'ready') = (mirror_tree IS NOT NULL))
);
`;

/** The commit a cloud conversation's worktree was on after its last sync, so commits made on the Mac reach the sandbox. */
export const cloudWorkspaceMirrorHeadMigration = `ALTER TABLE cloud_workspaces ADD COLUMN mirror_head TEXT;`;

/**
 * A conversation's sandbox can be deleted from Settings: `removed` until its next turn sets up a new one. SQLite cannot
 * change a CHECK, so the table is made again with the same rows.
 */
export const cloudWorkspaceRemovedMigration = `
CREATE TABLE cloud_workspaces_next (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('local', 'vercel')),
  sandbox TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'failed', 'removed')),
  error TEXT,
  mirror_snapshot TEXT,
  mirror_tree TEXT,
  mirror_head TEXT,
  mirror_known TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'ready') = (mirror_tree IS NOT NULL))
);
INSERT INTO cloud_workspaces_next (thread_id, provider, sandbox, state, error, mirror_snapshot, mirror_tree, mirror_head, mirror_known, created_at, updated_at)
  SELECT thread_id, provider, sandbox, state, error, mirror_snapshot, mirror_tree, mirror_head, mirror_known, created_at, updated_at FROM cloud_workspaces;
DROP TABLE cloud_workspaces;
ALTER TABLE cloud_workspaces_next RENAME TO cloud_workspaces;
`;

/**
 * Agent37 runs cloud conversations too. The table is made again with the provider's CHECK widened and every column it
 * has by now, so it also opens a ledger migrated again from an earlier version.
 */
export function cloudWorkspaceAgent37Migration(raw: DatabaseSync): void {
  const table = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cloud_workspaces'").get() as { sql: string } | undefined;
  if (!table || table.sql.includes("'agent37'")) return;
  const columns = (raw.prepare("PRAGMA table_info(cloud_workspaces)").all() as { name: string }[]).map((column) => column.name).join(", ");
  const next = table.sql
    .replace(/^CREATE TABLE\s+"?cloud_workspaces"?/, "CREATE TABLE cloud_workspaces_next")
    .replace("CHECK (provider IN ('local', 'vercel'))", "CHECK (provider IN ('local', 'vercel', 'agent37'))");
  raw.exec(`${next};
INSERT INTO cloud_workspaces_next (${columns}) SELECT ${columns} FROM cloud_workspaces;
DROP TABLE cloud_workspaces;
ALTER TABLE cloud_workspaces_next RENAME TO cloud_workspaces;`);
}

/**
 * What a cloud conversation's sandbox got of its saved session, so a turn's end writes the host only when it changed.
 * Added only where missing, like the cloud brain's tables, so a ledger migrated again from an earlier version opens.
 */
export function cloudWorkspaceSessionBaseMigration(raw: DatabaseSync): void {
  const columns = raw.prepare("PRAGMA table_info(cloud_workspaces)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "session_base")) raw.exec("ALTER TABLE cloud_workspaces ADD COLUMN session_base TEXT;");
}
