import type { Db } from "./database.js";

export type CloudProviderId = "local" | "vercel";
/** `removed`: its sandbox was deleted; the next turn sets up a new one from the worktree on the Mac. */
export type CloudWorkspaceState = "preparing" | "ready" | "failed" | "removed";

/**
 * What a sandbox got of its conversation's saved session and what the host held then, each by a digest only comparable
 * with another from the same side; compared after the next turn.
 */
export interface SessionBase {
  sessionId: string;
  host: string | null;
  sandbox: string;
}

/** What the Mac's worktree last matched in the sandbox. */
export interface CloudMirrorState {
  snapshot: string | null;
  tree: string;
  head: string | null;
  known: string[];
}

export interface CloudWorkspaceRecord {
  threadId: string;
  provider: CloudProviderId;
  sandbox: string;
  state: CloudWorkspaceState;
  error: string | null;
  /** Null until the sandbox has the code. */
  mirror: CloudMirrorState | null;
  sessionBase: SessionBase | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  thread_id: string;
  provider: CloudProviderId;
  sandbox: string;
  state: CloudWorkspaceState;
  error: string | null;
  mirror_snapshot: string | null;
  mirror_tree: string | null;
  mirror_head: string | null;
  mirror_known: string;
  session_base: string | null;
  created_at: number;
  updated_at: number;
}

const columns = "thread_id, provider, sandbox, state, error, mirror_snapshot, mirror_tree, mirror_head, mirror_known, session_base, created_at, updated_at";
const record = (row: Row): CloudWorkspaceRecord => ({
  threadId: row.thread_id,
  provider: row.provider,
  sandbox: row.sandbox,
  state: row.state,
  error: row.error,
  mirror: row.mirror_tree === null ? null : { snapshot: row.mirror_snapshot, tree: row.mirror_tree, head: row.mirror_head, known: JSON.parse(row.mirror_known) as string[] },
  sessionBase: row.session_base === null ? null : (JSON.parse(row.session_base) as SessionBase),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const cloudWorkspaces = {
  insert(db: Db, input: { threadId: string; provider: CloudProviderId; sandbox: string; at?: number }): CloudWorkspaceRecord {
    const at = input.at ?? Date.now();
    const row = db
      .stmt(`INSERT INTO cloud_workspaces (thread_id, provider, sandbox, state, created_at, updated_at) VALUES (?, ?, ?, 'preparing', ?, ?) RETURNING ${columns}`)
      .get(input.threadId, input.provider, input.sandbox, at, at) as unknown as Row;
    return record(row);
  },
  get(db: Db, threadId: string): CloudWorkspaceRecord | null {
    const row = db.stmt(`SELECT ${columns} FROM cloud_workspaces WHERE thread_id = ?`).get(threadId) as unknown as Row | undefined;
    return row ? record(row) : null;
  },
  /** The sandbox has the code and the worktree matches `mirror`. */
  ready(db: Db, threadId: string, mirror: CloudMirrorState, at = Date.now()): CloudWorkspaceRecord {
    const row = db
      .stmt(
        `UPDATE cloud_workspaces SET state = 'ready', error = NULL, mirror_snapshot = ?, mirror_tree = ?, mirror_head = ?, mirror_known = ?, updated_at = ? WHERE thread_id = ? RETURNING ${columns}`,
      )
      .get(mirror.snapshot, mirror.tree, mirror.head, JSON.stringify(mirror.known), at, threadId) as unknown as Row | undefined;
    if (!row) throw new Error(`No cloud workspace for thread ${threadId}`);
    return record(row);
  },
  /** A failed or removed workspace is being prepared again; its old error no longer applies. */
  preparing(db: Db, threadId: string, at = Date.now()): void {
    db.stmt("UPDATE cloud_workspaces SET state = 'preparing', error = NULL, updated_at = ? WHERE thread_id = ? AND state IN ('failed', 'removed')").run(at, threadId);
  },
  /** Its sandbox was deleted. What the sandbox had synced stays in the worktree, which the next sandbox starts from. */
  removed(db: Db, threadId: string, at = Date.now()): void {
    db.stmt(
      "UPDATE cloud_workspaces SET state = 'removed', error = NULL, mirror_snapshot = NULL, mirror_tree = NULL, mirror_head = NULL, mirror_known = '[]', session_base = NULL, updated_at = ? WHERE thread_id = ?",
    ).run(at, threadId);
  },
  /** Every conversation's workspace on one service, by sandbox name. */
  listByProvider(db: Db, provider: CloudProviderId): CloudWorkspaceRecord[] {
    return (db.stmt(`SELECT ${columns} FROM cloud_workspaces WHERE provider = ?`).all(provider) as unknown as Row[]).map(record);
  },
  /** What the sandbox got of the conversation's session after the last send or keep; null forgets it. */
  setSessionBase(db: Db, threadId: string, base: SessionBase | null): void {
    db.stmt("UPDATE cloud_workspaces SET session_base = ? WHERE thread_id = ?").run(base ? JSON.stringify(base) : null, threadId);
  },
  /** Preparation failed before the sandbox had the code; preparing again retries it. */
  failed(db: Db, threadId: string, error: string, at = Date.now()): void {
    db.stmt("UPDATE cloud_workspaces SET state = 'failed', error = ?, updated_at = ? WHERE thread_id = ? AND state != 'ready'").run(error, at, threadId);
  },
};
