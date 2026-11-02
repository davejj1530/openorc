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
