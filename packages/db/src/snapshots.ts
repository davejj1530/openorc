import type { Snapshot } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import type { Db } from "./database.js";

interface SnapshotRow {
  id: string;
  task_id: string;
  run_id: string | null;
  turn: number;
  tree_sha: string;
  diff_stat: string;
  created_at: number;
}

export const snapshots = {
  get(db: Db, id: string): Snapshot | null {
    const r = db.stmt("SELECT * FROM snapshots WHERE id = ?").get(id) as unknown as SnapshotRow | undefined;
    return r ? { id: r.id, taskId: r.task_id, runId: r.run_id, turn: r.turn, treeSha: r.tree_sha, diffStat: JSON.parse(r.diff_stat) as Snapshot["diffStat"], createdAt: r.created_at } : null;
  },
  latestForTask(db: Db, taskId: string): Snapshot | null {
    const r = db.stmt("SELECT * FROM snapshots WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as unknown as SnapshotRow | undefined;
    return r ? snapshots.get(db, r.id) : null;
  },
  listForTask(db: Db, taskId: string): Snapshot[] {
    return (db.stmt("SELECT * FROM snapshots WHERE task_id = ? ORDER BY created_at").all(taskId) as unknown as SnapshotRow[]).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      runId: r.run_id,
      turn: r.turn,
      treeSha: r.tree_sha,
      diffStat: JSON.parse(r.diff_stat) as Snapshot["diffStat"],
      createdAt: r.created_at,
    }));
  },
  insert(db: Db, s: { taskId: string; runId: string | null; turn: number; treeSha: string; diffStat: Snapshot["diffStat"] }): Snapshot {
    const id = randomUUID();
    const t = Date.now();
    db.stmt("INSERT INTO snapshots (id, task_id, run_id, turn, tree_sha, diff_stat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      s.taskId,
      s.runId,
      s.turn,
      s.treeSha,
      JSON.stringify(s.diffStat),
      t,
    );
    return { id, taskId: s.taskId, runId: s.runId, turn: s.turn, treeSha: s.treeSha, diffStat: s.diffStat, createdAt: t };
  },
};
