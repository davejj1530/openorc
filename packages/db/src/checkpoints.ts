import { randomUUID } from "node:crypto";
import type { ThreadCheckpoint } from "@openorc/protocol";
import type { Db } from "./database.js";

interface CheckpointRow {
  id: string;
  thread_id: string;
  run_id: string | null;
  turn: number;
  tree_sha: string;
  diff_stat: string;
  note: string | null;
  root: string | null;
  outside: ThreadCheckpoint["outside"];
  created_at: number;
}

function fromRow(r: CheckpointRow): ThreadCheckpoint {
  return {
    id: r.id,
    threadId: r.thread_id,
    runId: r.run_id,
    turn: r.turn,
    treeSha: r.tree_sha,
    diffStat: JSON.parse(r.diff_stat) as ThreadCheckpoint["diffStat"],
    note: r.note,
    root: r.root,
    outside: r.outside,
    createdAt: r.created_at,
  };
}

type CheckpointInput = Pick<ThreadCheckpoint, "threadId" | "runId" | "turn" | "treeSha" | "diffStat"> & Partial<Pick<ThreadCheckpoint, "note" | "root" | "outside">>;

/** One tree hash per finished turn on a thread, so the working tree can be put back. */
export const checkpoints = {
  listForThread(db: Db, threadId: string): ThreadCheckpoint[] {
    return (db.stmt("SELECT * FROM thread_checkpoints WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as unknown as CheckpointRow[]).map(fromRow);
  },
  get(db: Db, id: string): ThreadCheckpoint | null {
    const r = db.stmt("SELECT * FROM thread_checkpoints WHERE id = ?").get(id) as unknown as CheckpointRow | undefined;
    return r ? fromRow(r) : null;
  },
  insert(db: Db, c: CheckpointInput): ThreadCheckpoint {
    const id = randomUUID();
    const t = Date.now();
    const note = c.note ?? null;
    const root = c.root ?? null;
    const outside = c.outside ?? null;
    db.stmt("INSERT INTO thread_checkpoints (id, thread_id, run_id, turn, tree_sha, diff_stat, note, root, outside, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      c.threadId,
      c.runId,
      c.turn,
      c.treeSha,
      JSON.stringify(c.diffStat),
      note,
      root,
      outside,
      t,
    );
    return { id, threadId: c.threadId, runId: c.runId, turn: c.turn, treeSha: c.treeSha, diffStat: c.diffStat, note, root, outside, createdAt: t };
  },
  /**
   * Whether an agent other than `threadId`'s own may have worked in `root` since `since`: another thread saved a turn
   * there, a run of another conversation started there, or a task run there was still going. Comment runs only
   * talk, and a thread's process rests between turns, so a thread run's end time says nothing.
   */
  agentWorkSince(db: Db, input: { root: string; threadId: string; since: number }): boolean {
    const { root, threadId, since } = input;
    const row = db
      .stmt(
        `SELECT 1 AS found FROM thread_checkpoints WHERE root = ? AND run_id IS NOT NULL AND thread_id != ? AND created_at >= ?
         UNION ALL
         SELECT 1 FROM runs WHERE working_directory = ? AND comment_turn_id IS NULL AND (thread_id IS NULL OR thread_id != ?)
           AND (started_at >= ? OR (task_id IS NOT NULL AND (ended_at IS NULL OR ended_at >= ?)))
         LIMIT 1`,
      )
      .get(root, threadId, since, root, threadId, since, since);
    return row !== undefined;
  },
};
