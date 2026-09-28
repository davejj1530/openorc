import { randomUUID } from "node:crypto";
import type { ThreadCheckpoint } from "@openorc/protocol";
import type { Db } from "../database.js";

/** Keep historical migration fixtures independent of columns added by later migrations. */
export function insertLegacyCheckpoint(db: Db, input: Pick<ThreadCheckpoint, "threadId" | "runId" | "turn" | "treeSha" | "diffStat">): ThreadCheckpoint {
  const checkpoint = { ...input, id: randomUUID(), createdAt: Date.now(), note: null, root: null };
  db.stmt("INSERT INTO thread_checkpoints (id, thread_id, run_id, turn, tree_sha, diff_stat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    checkpoint.id,
    checkpoint.threadId,
    checkpoint.runId,
    checkpoint.turn,
    checkpoint.treeSha,
    JSON.stringify(checkpoint.diffStat),
    checkpoint.createdAt,
  );
  return checkpoint;
}
