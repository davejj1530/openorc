import { randomUUID } from "node:crypto";
import type { Db } from "./database.js";

/**
 * This Mac's journal of a thread moving between it and OpenOrc Cloud (core `CloudMoves`), in `thread_relocations`
 * (relocation-schema.ts), one row per move, written by this Mac alone (role `coordinator`):
 *
 *   to-cloud   frozen (packing; the thread takes no message) -> sending (the arrival is made on the server) -> done
 *   to-mac     asking (the thread leaves its machine with a save) -> received (its rows are here, hidden) -> done
 *
 * Either ends `abandoned` with the words why when it stops before its commit point, and the thread is where it was.
 * One open move per thread, by the table's own index.
 */
export type MoveDirection = "to-cloud" | "to-mac";
export type MovePhase = "frozen" | "sending" | "asking" | "received" | "done" | "abandoned";

export interface CloudMove {
  id: string;
  threadId: string;
  direction: MoveDirection;
  phase: MovePhase;
  /** The step under way, for the thread's place row; null between steps. */
  step: string | null;
  /** Why it stopped, for "Didn't move"; null while under way and once done. */
  error: string | null;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
}

const OPEN: readonly MovePhase[] = ["frozen", "sending", "asking", "received"];

interface Row {
  id: string;
  thread_id: string;
  direction: MoveDirection;
  phase: MovePhase;
  step: string | null;
  error: string | null;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (row: Row): CloudMove => ({
  id: row.id,
  threadId: row.thread_id,
  direction: row.direction,
  phase: row.phase,
  step: row.step,
  error: row.error,
  projectId: row.project_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const marks = OPEN.map(() => "?").join(", ");

export const cloudMoves = {
  /** The thread's move under way, or null. */
  open(db: Db, threadId: string): CloudMove | null {
    const row = db.stmt(`SELECT * FROM thread_relocations WHERE thread_id = ? AND role = 'coordinator' AND phase IN (${marks})`).get(threadId, ...OPEN) as unknown as Row | undefined;
    return row ? fromRow(row) : null;
  },

  /** The thread's newest move, under way or ended. */
  latest(db: Db, threadId: string): CloudMove | null {
    const row = db.stmt("SELECT * FROM thread_relocations WHERE thread_id = ? AND role = 'coordinator' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId) as unknown as Row | undefined;
    return row ? fromRow(row) : null;
  },

  /** Every move under way, oldest first: what a start picks up. */
  allOpen(db: Db): CloudMove[] {
    return (db.stmt(`SELECT * FROM thread_relocations WHERE role = 'coordinator' AND phase IN (${marks}) ORDER BY created_at`).all(...OPEN) as unknown as Row[]).map(fromRow);
  },

  /** Begins a move; throws while one is under way for the thread (the table's unique index). */
  begin(db: Db, move: { threadId: string; direction: MoveDirection; projectId: string | null }, now = Date.now()): CloudMove {
    const id = randomUUID();
    const phase: MovePhase = move.direction === "to-cloud" ? "frozen" : "asking";
    db.stmt(
      "INSERT INTO thread_relocations (id, thread_id, role, direction, phase, project_id, error, cleanup, step, created_at, updated_at) VALUES (?, ?, 'coordinator', ?, ?, ?, NULL, NULL, NULL, ?, ?)",
    ).run(id, move.threadId, move.direction, phase, move.projectId, now, now);
    return cloudMoves.open(db, move.threadId)!;
  },

  /** Moves a move on: its phase, its step, or the words it stopped with. */
  set(db: Db, id: string, patch: { phase?: MovePhase; step?: string | null; error?: string | null }, now = Date.now()): void {
    const row = db.stmt("SELECT * FROM thread_relocations WHERE id = ?").get(id) as unknown as Row | undefined;
    if (!row) return;
    db.stmt("UPDATE thread_relocations SET phase = ?, step = ?, error = ?, updated_at = ? WHERE id = ?").run(
      patch.phase ?? row.phase,
      patch.step === undefined ? row.step : patch.step,
      patch.error === undefined ? row.error : patch.error,
      now,
      id,
    );
  },

  /** Where the thread is moving, or why its last move stopped; null when neither. What its summary says. */
  moving(db: Db, threadId: string): { to: "cloud" | "mac"; failed: string | null } | null {
    const move = cloudMoves.latest(db, threadId);
    if (!move || move.phase === "done") return null;
    const to = move.direction === "to-cloud" ? "cloud" : "mac";
    if (move.phase === "abandoned") return move.error ? { to, failed: move.error } : null;
    return { to, failed: null };
  },

  /** Forgets the thread's moves: a thread that is gone from this Mac keeps none. */
  forget(db: Db, threadId: string): void {
    db.stmt("DELETE FROM thread_relocations WHERE thread_id = ? AND role = 'coordinator'").run(threadId);
  },
};
