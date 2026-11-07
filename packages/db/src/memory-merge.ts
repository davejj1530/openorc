import type { Memory } from "@openorc/protocol";
import type { Db } from "./database.js";
import { memories } from "./memories.js";
import { redact } from "./redact.js";

/** A project memory one side removed: the other drops it and never takes it back. */
export interface MemoryTombstone {
  id: string;
  removedAt: number;
}

/** What one side's copy of a project's memory changed: rows whole, removals by id. */
export interface MemoryChanges {
  rows: Memory[];
  removed: MemoryTombstone[];
}

/** What taking the other side's changes did here. */
export interface MemoryMerge {
  /** Rows written, to embed again. */
  written: Memory[];
  /** Rows deleted. */
  deleted: string[];
  /** Rows here that beat one of the other side's: it lacks them, or holds an older one. */
  kept: Memory[];
}

const MAX_ROWS = 2000;

/**
 * A project's memories and removals changed at or after `since` on this ledger's clock, and where the next read starts.
 * At most MAX_ROWS rows, oldest first, with every row of the last one's millisecond, so the next read starts past them;
 * `more` when rows were left for that read.
 */
export function memoryChangesSince(db: Db, projectId: string, since: number): MemoryChanges & { next: number; more: boolean } {
  const now = Date.now();
  const ids = db.stmt("SELECT id, updated_at FROM memories WHERE project_id = ? AND orcling_id IS NULL AND updated_at >= ? ORDER BY updated_at, id LIMIT ?").all(projectId, since, MAX_ROWS + 1) as {
    id: string;
    updated_at: number;
  }[];
  const cut = ids.length > MAX_ROWS ? ids[MAX_ROWS - 1]!.updated_at : null;
  const rows =
    cut === null
      ? ids
      : (db.stmt("SELECT id, updated_at FROM memories WHERE project_id = ? AND orcling_id IS NULL AND updated_at >= ? AND updated_at <= ? ORDER BY updated_at, id").all(projectId, since, cut) as {
          id: string;
        }[]);
  const removed = (db.stmt("SELECT id, removed_at FROM memory_tombstones WHERE project_id = ? AND removed_at >= ?").all(projectId, since) as { id: string; removed_at: number }[]).map((row) => ({
    id: row.id,
    removedAt: row.removed_at,
  }));
  return { rows: rows.flatMap((row) => memories.get(db, row.id) ?? []), removed, next: cut === null ? now : cut + 1, more: cut !== null };
}

/** The same fact as last told: the later edit, then the later confirmation, then the larger text, so both sides agree. */
function newer(a: Memory, b: Memory): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.lastConfirmedAt !== b.lastConfirmedAt) return a.lastConfirmedAt > b.lastConfirmedAt;
  const [x, y] = [`${a.title}\n${a.body}`, `${b.title}\n${b.body}`];
  return x !== y ? x > y : a.id > b.id;
}

/** On one topic, what the user wrote stays theirs, as recording keeps it; otherwise the newer fact replaces the older. */
const beats = (a: Memory, b: Memory) => ((a.source === "user") !== (b.source === "user") ? a.source === "user" : newer(a, b));

const exists = (db: Db, table: "runs" | "tasks", id: string | null) => (id && db.stmt(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) ? id : null);

function write(db: Db, projectId: string, row: Memory, here: boolean): void {
  const values = [
    row.type,
    row.topicKey,
    redact(row.title).text,
    redact(row.body).text,
    row.confidence,
    row.status,
    row.source,
    exists(db, "runs", row.sourceRunId),
    exists(db, "tasks", row.sourceTaskId),
    row.evidenceCount,
    row.createdAt,
    row.updatedAt,
    row.lastConfirmedAt,
  ];
  if (here)
    db.stmt(
      "UPDATE memories SET type = ?, topic_key = ?, title = ?, body = ?, confidence = ?, status = ?, source = ?, source_run_id = ?, source_task_id = ?, evidence_count = ?, created_at = ?, updated_at = ?, last_confirmed_at = ? WHERE id = ?",
    ).run(...values, row.id);
  else
    db.stmt(
      "INSERT INTO memories (type, topic_key, title, body, confidence, status, source, source_run_id, source_task_id, evidence_count, created_at, updated_at, last_confirmed_at, id, scope, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'project', ?)",
    ).run(...values, row.id, projectId);
  memories.setFiles(db, row.id, row.files);
}

const tombstoned = (db: Db, id: string) => db.stmt("SELECT 1 FROM memory_tombstones WHERE id = ?").get(id) !== undefined;

/** Takes one of the other side's rows, unless this side holds a newer one, or a winner on its topic. */
function take(db: Db, projectId: string, row: Memory, result: MemoryMerge, remove: (id: string, at: number) => void): void {
  const here = memories.get(db, row.id);
  if (here && (here.projectId !== projectId || here.orclingId)) return;
  if (here && !newer(row, here)) {
    if (newer(here, row)) result.kept.push(here);
    return;
  }
  const rival = row.status === "active" && row.topicKey ? memories.activeOnTopic(db, projectId, row.topicKey) : null;
  if (rival && rival.id !== row.id) {
    if (beats(rival, row)) {
      remove(row.id, Date.now());
      result.kept.push(rival);
      return;
    }
    remove(rival.id, Date.now());
  }
  write(db, projectId, row, here !== null);
  result.written.push(memories.get(db, row.id)!);
}

/**
 * Takes the other side's changes to a project's memory in one transaction. Rows match by id, and the newer wins whole.
 * Two active rows on one topic keep the winner by `beats`; the loser is removed on both sides by its tombstone. A
 * removal deletes the row and keeps it from coming back. Taking the same changes again changes nothing.
 */
export function mergeMemories(db: Db, projectId: string, changes: MemoryChanges): MemoryMerge {
  const result: MemoryMerge = { written: [], deleted: [], kept: [] };
  const remove = (id: string, at: number) => {
    if (memories.get(db, id)) {
      memories.remove(db, id, at);
      result.deleted.push(id);
    } else db.stmt("INSERT OR IGNORE INTO memory_tombstones (id, project_id, removed_at) VALUES (?, ?, ?)").run(id, projectId, at);
  };
  return db.transaction(() => {
    for (const { id, removedAt } of changes.removed) if (!tombstoned(db, id)) remove(id, removedAt);
    for (const row of [...changes.rows].sort((a, b) => a.updatedAt - b.updatedAt)) if (!tombstoned(db, row.id)) take(db, projectId, row, result, remove);
    return result;
  });
}
