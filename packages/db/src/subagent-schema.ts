import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const subagentMigration = `
  ALTER TABLE threads ADD COLUMN parent_relation TEXT CHECK (parent_relation IN ('started', 'subagent'));
  UPDATE threads SET parent_relation = 'started' WHERE parent_thread_id IS NOT NULL;
  CREATE TABLE subagents (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
    host_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    native_id TEXT NOT NULL,
    tool_call_id TEXT,
    task_id TEXT,
    agent_type TEXT,
    prompt TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
    result TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE (host_run_id, native_id)
  );
`;

export function subagentIdentityMigration(raw: DatabaseSync): void {
  raw.exec(`
  ALTER TABLE subagents ADD COLUMN root_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
  WITH RECURSIVE ancestors(child, id) AS (
    SELECT thread_id, thread_id FROM subagents
    UNION ALL
    SELECT a.child, t.parent_thread_id FROM ancestors a JOIN threads t ON t.id = a.id
    WHERE t.parent_relation = 'subagent' AND t.parent_thread_id IS NOT NULL
  )
  UPDATE subagents SET root_thread_id = (
    SELECT a.id FROM ancestors a JOIN threads t ON t.id = a.id
    WHERE a.child = subagents.thread_id AND (t.parent_relation IS NULL OR t.parent_relation != 'subagent')
  );
  UPDATE runs SET
    state = CASE s.status WHEN 'completed' THEN 'success' WHEN 'failed' THEN 'error' ELSE 'cancelled' END,
    ended_at = coalesce(s.ended_at, s.started_at),
    result_text = CASE WHEN s.status = 'stopped' THEN NULL ELSE coalesce(s.result, runs.result_text) END
  FROM subagents s WHERE runs.id = s.run_id AND s.status != 'running' AND runs.state IN ('starting', 'running');
  `);
  // Earlier builds could save the same native child under several host runs. Keep its first thread and all history.
  const aliases = raw
    .prepare(
      `SELECT thread_id AS oldId, first_value(thread_id) OVER (
    PARTITION BY root_thread_id, native_id ORDER BY started_at, thread_id) AS canonicalId FROM subagents`,
    )
    .all();
  const references = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .flatMap((table) => {
      const name = String(table.name);
      return raw
        .prepare(`PRAGMA foreign_key_list(${quote(name)})`)
        .all()
        .filter((fk) => fk.table === "threads" && !(name === "subagents" && fk.from === "thread_id"))
        .map((fk) => ({ table: name, column: String(fk.from) }));
    });
  for (const alias of aliases) {
    const oldId = String(alias.oldId),
      canonicalId = String(alias.canonicalId);
    if (oldId === canonicalId) continue;
    // A merged historical run no longer has its own status row for startup recovery.
    raw.prepare("UPDATE runs SET state = 'cancelled', ended_at = coalesce(ended_at, started_at) WHERE thread_id = ? AND state IN ('starting', 'running')").run(oldId);
    for (const ref of references) mergeReference(raw, ref, oldId, canonicalId);
    for (const event of raw
      .prepare(
        `SELECT e.id, a.id AS artifactId, coalesce(a.content, e.payload) AS payload FROM events e
      LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload' WHERE e.kind IN ('subagent.started', 'subagent.updated')
      AND json_extract(coalesce(a.content, e.payload), '$.threadId') = ?`,
      )
      .all(oldId)) {
      const payload = JSON.stringify({ ...JSON.parse(String(event.payload)), threadId: canonicalId });
      const hash = createHash("sha256").update(payload).digest("hex");
      if (event.artifactId) raw.prepare("UPDATE artifacts SET content = ?, sha256 = ?, bytes = ? WHERE id = ?").run(payload, hash, Buffer.byteLength(payload), event.artifactId);
      else raw.prepare("UPDATE events SET payload = ? WHERE id = ?").run(payload, event.id!);
      raw.prepare("UPDATE events SET payload_sha256 = ?, bytes = ? WHERE id = ?").run(hash, Buffer.byteLength(payload), event.id!);
    }
    raw.prepare("DELETE FROM subagents WHERE thread_id = ?").run(oldId);
    raw.prepare("DELETE FROM threads WHERE id = ?").run(oldId);
  }
  raw.exec("CREATE UNIQUE INDEX subagents_identity ON subagents(root_thread_id, native_id)");
}

function mergeReference(raw: DatabaseSync, ref: { table: string; column: string }, oldId: string, canonicalId: string): void {
  const table = quote(ref.table),
    column = quote(ref.column);
  const conflicts =
    ref.column === "thread_id" && ["conversation_plans", "thread_queue", "thread_messages", "cloud_workspaces", "orclings", "pull_request_reviews", "orchestration_team_instances"].includes(ref.table);
  raw.prepare(`UPDATE ${conflicts ? "OR IGNORE " : ""}${table} SET ${column} = ? WHERE ${column} = ?`).run(canonicalId, oldId);
  if (!conflicts) return;
  if (ref.table === "conversation_plans") {
    // Keep both documents; their thread-local revision numbers may overlap.
    for (const plan of raw.prepare("SELECT id FROM conversation_plans WHERE thread_id = ? ORDER BY revision").all(oldId)) {
      raw
        .prepare(
          `UPDATE conversation_plans SET thread_id = ?, revision =
        (SELECT coalesce(max(revision), 0) + 1 FROM conversation_plans WHERE thread_id = ?) WHERE id = ?`,
        )
        .run(canonicalId, canonicalId, plan.id!);
    }
  } else if (ref.table === "pull_request_reviews") {
    // A second review keeps its draft/comments, but cannot also own the surviving conversation.
    raw.prepare("UPDATE pull_request_reviews SET thread_id = NULL WHERE thread_id = ?").run(oldId);
  } else {
    // Singleton settings and duplicate request/message identities keep the survivor's row.
    raw.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(oldId);
  }
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Existing databases may already have the earlier four-state CHECK constraint. */
export const subagentObservationMigration = `
  CREATE TABLE subagents_observed (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
    host_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    native_id TEXT NOT NULL,
    tool_call_id TEXT,
    task_id TEXT,
    agent_type TEXT,
    prompt TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped', 'no_updates')),
    result TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    root_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    UNIQUE (host_run_id, native_id)
  );
  INSERT INTO subagents_observed SELECT * FROM subagents;
  DROP TABLE subagents;
  ALTER TABLE subagents_observed RENAME TO subagents;
  CREATE UNIQUE INDEX subagents_identity ON subagents(root_thread_id, native_id);
`;

/**
 * A person can start a thread under another too; the limits on threads started with thread_start hold only for an
 * agent's. A started thread that joined its parent's worktree takes the parent's branch, so it no longer reads as a
 * pull request's detached copy. Added only where missing, so a ledger migrated again from an earlier version keeps the
 * threads people started as theirs.
 */
export function startedByAgentMigration(raw: DatabaseSync): void {
  const columns = raw.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
  if (columns.some((column) => column.name === "started_by_agent")) return;
  raw.exec(`ALTER TABLE threads ADD COLUMN started_by_agent INTEGER NOT NULL DEFAULT 0;
  UPDATE threads SET started_by_agent = 1 WHERE parent_relation = 'started';
  UPDATE threads SET branch = (SELECT parent.branch FROM threads parent WHERE parent.id = threads.parent_thread_id)
    WHERE parent_relation = 'started' AND branch IS NULL AND worktree_path IS NOT NULL
      AND worktree_path = (SELECT parent.worktree_path FROM threads parent WHERE parent.id = threads.parent_thread_id);`);
}

/** The thread that started this one with thread_start. A parent counts its working children by it. */
export const parentThreadMigration = `ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
  CREATE INDEX threads_parent ON threads(parent_thread_id) WHERE parent_thread_id IS NOT NULL;`;
