import { randomUUID } from "node:crypto";
import type { ExtractionJob, Memory, MemoryScope, MemorySource, MemoryStatus, MemoryType, SessionSummary } from "@openorc/protocol";
import type { Db } from "./database.js";
import { redact } from "./redact.js";

/** Memories and summaries return in later prompts, so what they keep is redacted like the ledger. */
const clean = (text: string) => redact(text).text;

const now = () => Date.now();

interface MemoryRow {
  id: string;
  scope: MemoryScope;
  project_id: string | null;
  type: MemoryType;
  topic_key: string | null;
  title: string;
  body: string;
  confidence: number;
  status: MemoryStatus;
  source: MemorySource;
  source_run_id: string | null;
  source_task_id: string | null;
  evidence_count: number;
  created_at: number;
  updated_at: number;
  last_confirmed_at: number;
}

function fromRow(db: Db, r: MemoryRow): Memory {
  const files = (db.stmt("SELECT path_glob FROM memory_files WHERE memory_id = ?").all(r.id) as unknown as { path_glob: string }[]).map((f) => f.path_glob);
  return {
    id: r.id,
    scope: r.scope,
    projectId: r.project_id,
    type: r.type,
    topicKey: r.topic_key,
    title: r.title,
    body: r.body,
    confidence: r.confidence,
    status: r.status,
    source: r.source,
    sourceRunId: r.source_run_id,
    sourceTaskId: r.source_task_id,
    evidenceCount: r.evidence_count,
    files,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastConfirmedAt: r.last_confirmed_at,
  };
}

export interface MemoryInput {
  scope?: MemoryScope;
  projectId: string | null;
  type: MemoryType;
  topicKey?: string | null;
  title: string;
  body: string;
  confidence?: number;
  source: MemorySource;
  sourceRunId?: string | null;
  sourceTaskId?: string | null;
  files?: string[];
}

export interface MemoryFilter {
  projectId?: string;
  types?: MemoryType[];
  sources?: MemorySource[];
  statuses?: MemoryStatus[];
  taskId?: string;
  limit?: number;
  offset?: number;
}

/** Turn free text into an FTS5 query: each word quoted, ORed, last word prefixed. */
export function ftsQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[./-]+|[./-]+$/g, ""))
    .filter((w) => w.length > 1);
  if (words.length === 0) return null;
  const unique = [...new Set(words)].slice(0, 12);
  return unique.map((w, i) => (i === unique.length - 1 ? `"${w}"*` : `"${w}"`)).join(" OR ");
}

export const memories = {
  get(db: Db, id: string): Memory | null {
    const r = db.stmt("SELECT * FROM memories WHERE id = ?").get(id) as unknown as MemoryRow | undefined;
    return r ? fromRow(db, r) : null;
  },

  list(db: Db, filter: MemoryFilter = {}): Memory[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.projectId) {
      where.push("(project_id = ? OR scope IN ('user', 'global'))");
      args.push(filter.projectId);
    }
    if (filter.types && filter.types.length > 0) {
      where.push(`type IN (${filter.types.map(() => "?").join(",")})`);
      args.push(...filter.types);
    }
    if (filter.sources && filter.sources.length > 0) {
      where.push(`source IN (${filter.sources.map(() => "?").join(",")})`);
      args.push(...filter.sources);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      args.push(...filter.statuses);
    }
    if (filter.taskId) {
      where.push("source_task_id = ?");
      args.push(filter.taskId);
    }
    const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`;
    args.push(filter.limit ?? 200, filter.offset ?? 0);
    return (db.stmt(sql).all(...args) as unknown as MemoryRow[]).map((r) => fromRow(db, r));
  },

  /** BM25 candidates for a query, active only, scoped to a project plus user and global memories. */
  search(db: Db, query: string, projectId: string | null, limit = 40): { memory: Memory; rank: number }[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = db
      .stmt(
        `SELECT m.*, bm25(memories_fts, 2.0, 1.0) AS rank
         FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active' AND (m.project_id = ? OR m.scope IN ('user', 'global'))
         ORDER BY rank LIMIT ?`,
      )
      .all(q, projectId ?? "", limit) as unknown as (MemoryRow & { rank: number })[];
    return rows.map((r) => ({ memory: fromRow(db, r), rank: r.rank }));
  },

  /**
   * Insert, or fold into the active memory with the same topic key: the body
   * is refreshed, evidence grows, and the confirmation clock resets.
   */
  upsert(db: Db, input: MemoryInput): { memory: Memory; merged: boolean } {
    const t = now();
    if (input.topicKey) {
      const existing = db.stmt("SELECT * FROM memories WHERE project_id IS ? AND topic_key = ? AND status = 'active'").get(input.projectId, input.topicKey) as unknown as MemoryRow | undefined;
      // What the user wrote stays as they wrote it.
      if (existing?.source === "user" && input.source !== "user")
        throw new Error("A memory the user wrote uses this topic key, and only the user can change it. Record the new fact under another topic key, or without one.");
      if (existing) {
        db.stmt(
          "UPDATE memories SET title = ?, body = ?, confidence = MIN(1.0, confidence + 0.1), evidence_count = evidence_count + 1, updated_at = ?, last_confirmed_at = ?, source_run_id = COALESCE(?, source_run_id) WHERE id = ?",
        ).run(clean(input.title), clean(input.body), t, t, input.sourceRunId ?? null, existing.id);
        memories.setFiles(db, existing.id, input.files ?? []);
        return { memory: memories.get(db, existing.id) as Memory, merged: true };
      }
    }
    const id = randomUUID();
    db.stmt(
      "INSERT INTO memories (id, scope, project_id, type, topic_key, title, body, confidence, status, source, source_run_id, source_task_id, evidence_count, created_at, updated_at, last_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?, ?)",
    ).run(
      id,
      input.scope ?? "project",
      input.projectId,
      input.type,
      input.topicKey ?? null,
      clean(input.title),
      clean(input.body),
      input.confidence ?? 0.6,
      input.source,
      input.sourceRunId ?? null,
      input.sourceTaskId ?? null,
      t,
      t,
      t,
    );
    memories.setFiles(db, id, input.files ?? []);
    return { memory: memories.get(db, id) as Memory, merged: false };
  },

  /** Whether an active memory the user wrote holds this topic key. Only the user can change such a memory. */
  userOwnsTopic(db: Db, projectId: string | null, topicKey: string): boolean {
    return db.stmt("SELECT 1 FROM memories WHERE project_id IS ? AND topic_key = ? AND status = 'active' AND source = 'user'").get(projectId, topicKey) !== undefined;
  },

  setFiles(db: Db, id: string, files: string[]): void {
    db.stmt("DELETE FROM memory_files WHERE memory_id = ?").run(id);
    for (const f of files) db.stmt("INSERT INTO memory_files (memory_id, path_glob) VALUES (?, ?)").run(id, f);
  },

  update(db: Db, id: string, patch: { title?: string; body?: string; status?: MemoryStatus; confidence?: number; type?: MemoryType }): Memory {
    const sets: string[] = [];
    const args: (string | number)[] = [];
    const values = { ...patch, title: patch.title === undefined ? undefined : clean(patch.title), body: patch.body === undefined ? undefined : clean(patch.body) };
    for (const [k, col] of [
      ["title", "title"],
      ["body", "body"],
      ["status", "status"],
      ["confidence", "confidence"],
      ["type", "type"],
    ] as const) {
      const v = values[k];
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(v);
      }
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      args.push(now(), id);
      db.stmt(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    }
    const m = memories.get(db, id);
    if (!m) throw new Error(`memory ${id} not found`);
    return m;
  },

  feedback(db: Db, id: string, verdict: "helpful" | "wrong" | "stale"): Memory {
    const t = now();
    if (verdict === "helpful") db.stmt("UPDATE memories SET confidence = MIN(1.0, confidence + 0.1), last_confirmed_at = ?, updated_at = ? WHERE id = ?").run(t, t, id);
    else db.stmt("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(verdict === "wrong" ? "retracted" : "stale", t, id);
    const m = memories.get(db, id);
    if (!m) throw new Error(`memory ${id} not found`);
    return m;
  },

  remove(db: Db, id: string): void {
    const rowid = memories.rowidFor(db, id);
    db.stmt("DELETE FROM memories WHERE id = ?").run(id);
    if (rowid !== null && db.hasVectors) db.stmt("DELETE FROM memory_vec WHERE memory_rowid = ?").run(BigInt(rowid));
  },

  rowidFor(db: Db, id: string): number | null {
    const r = db.stmt("SELECT rowid FROM memories WHERE id = ?").get(id) as { rowid: number } | undefined;
    return r ? r.rowid : null;
  },
};

/**
 * Vector index over the same rows, keyed by memories.rowid. Present only when
 * sqlite-vec loaded (db.hasVectors); every call is a no-op otherwise.
 */
export const vectors = {
  put(db: Db, memoryId: string, embedding: Float32Array): void {
    if (!db.hasVectors) return;
    const rowid = memories.rowidFor(db, memoryId);
    if (rowid === null) return;
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    // vec0 has no UPSERT; replace the row.
    db.stmt("DELETE FROM memory_vec WHERE memory_rowid = ?").run(BigInt(rowid));
    db.stmt("INSERT INTO memory_vec (memory_rowid, embedding) VALUES (?, ?)").run(BigInt(rowid), buf);
  },

  /** Nearest active memories to a query vector, scoped to a project plus user and global. */
  knn(db: Db, embedding: Float32Array, projectId: string | null, limit = 40): { memory: Memory; distance: number }[] {
    if (!db.hasVectors) return [];
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const rows = db
      .stmt(
        `SELECT m.*, v.distance AS distance
         FROM memory_vec v JOIN memories m ON m.rowid = v.memory_rowid
         WHERE v.embedding MATCH ? AND v.k = ? AND m.status = 'active' AND (m.project_id = ? OR m.scope IN ('user', 'global'))
         ORDER BY v.distance`,
      )
      .all(buf, limit, projectId ?? "") as unknown as (MemoryRow & { distance: number })[];
    return rows.map((r) => ({ memory: fromRow(db, r), distance: r.distance }));
  },

  /** Memories that have no vector yet, so a backfill can embed them. */
  missing(db: Db, limit = 200): Memory[] {
    if (!db.hasVectors) return [];
    return (
      db.stmt("SELECT m.* FROM memories m LEFT JOIN memory_vec v ON v.memory_rowid = m.rowid WHERE v.memory_rowid IS NULL AND m.status = 'active' LIMIT ?").all(limit) as unknown as MemoryRow[]
    ).map((r) => fromRow(db, r));
  },
};

interface SummaryRow {
  run_id: string;
  task_id: string | null;
  thread_id: string | null;
  project_id: string;
  request: string;
  work_done: string;
  outcome: string;
  open_items: string;
  model: string | null;
  created_at: number;
}

const summaryFromRow = (r: SummaryRow): SessionSummary => ({
  runId: r.run_id,
  taskId: r.task_id,
  threadId: r.thread_id,
  projectId: r.project_id,
  request: r.request,
  workDone: r.work_done,
  outcome: r.outcome,
  openItems: JSON.parse(r.open_items) as string[],
  model: r.model,
  createdAt: r.created_at,
});

export const summaries = {
  upsert(db: Db, s: Omit<SessionSummary, "createdAt">): SessionSummary {
    db.stmt(
      "INSERT INTO session_summaries (run_id, task_id, thread_id, project_id, request, work_done, outcome, open_items, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET request = excluded.request, work_done = excluded.work_done, outcome = excluded.outcome, open_items = excluded.open_items, model = excluded.model",
    ).run(s.runId, s.taskId, s.threadId, s.projectId, clean(s.request), clean(s.workDone), clean(s.outcome), JSON.stringify(s.openItems.map(clean)), s.model, now());
    return summaries.forRun(db, s.runId) as SessionSummary;
  },
  forRun(db: Db, runId: string): SessionSummary | null {
    const r = db.stmt("SELECT * FROM session_summaries WHERE run_id = ?").get(runId) as unknown as SummaryRow | undefined;
    return r ? summaryFromRow(r) : null;
  },
  forTask(db: Db, taskId: string): SessionSummary[] {
    return (db.stmt("SELECT * FROM session_summaries WHERE task_id = ? ORDER BY created_at").all(taskId) as unknown as SummaryRow[]).map(summaryFromRow);
  },
  recent(db: Db, projectId: string, limit = 5): SessionSummary[] {
    return (db.stmt("SELECT * FROM session_summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as unknown as SummaryRow[]).map(summaryFromRow);
  },
};

interface JobRow {
  run_id: string;
  state: ExtractionJob["state"];
  error: string | null;
  memories_written: number;
  started_at: number;
  finished_at: number | null;
}

export const extractionJobs = {
  start(db: Db, runId: string): void {
    db.stmt(
      "INSERT INTO extraction_jobs (run_id, state, started_at) VALUES (?, 'running', ?) ON CONFLICT(run_id) DO UPDATE SET state = 'running', error = NULL, started_at = excluded.started_at, finished_at = NULL",
    ).run(runId, now());
  },
  finish(db: Db, runId: string, result: { state: "done" | "failed" | "skipped"; error?: string; memoriesWritten?: number }): void {
    db.stmt("UPDATE extraction_jobs SET state = ?, error = ?, memories_written = ?, finished_at = ? WHERE run_id = ?").run(
      result.state,
      result.error === undefined ? null : clean(result.error),
      result.memoriesWritten ?? 0,
      now(),
      runId,
    );
  },
  get(db: Db, runId: string): ExtractionJob | null {
    const r = db.stmt("SELECT * FROM extraction_jobs WHERE run_id = ?").get(runId) as unknown as JobRow | undefined;
    return r ? { runId: r.run_id, state: r.state, error: r.error, memoriesWritten: r.memories_written, startedAt: r.started_at, finishedAt: r.finished_at } : null;
  },
  forTask(db: Db, taskId: string): ExtractionJob[] {
    return (db.stmt("SELECT j.* FROM extraction_jobs j JOIN runs r ON r.id = j.run_id WHERE r.task_id = ? ORDER BY j.started_at").all(taskId) as unknown as JobRow[]).map((r) => ({
      runId: r.run_id,
      state: r.state,
      error: r.error,
      memoriesWritten: r.memories_written,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  },
};

export const settings = {
  get(db: Db, key: string): string | null {
    const r = db.stmt("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  },
  set(db: Db, key: string, value: string): void {
    db.stmt("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  },
  remove(db: Db, key: string): void {
    db.stmt("DELETE FROM settings WHERE key = ?").run(key);
  },
};
