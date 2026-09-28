import type { Run } from "@openorc/protocol";
import type { Db } from "../database.js";
import { runs } from "../repos.js";

type LegacyRun = Pick<Run, "id" | "taskId" | "threadId" | "agent" | "model" | "mode" | "permissionMode"> & Partial<Pick<Run, "effort" | "fastMode">>;

/**
 * Seed a run using the version-7 columns, before working directories and
 * comment turns existed. Shared migration fixtures also run on newer schemas,
 * where the omitted nullable columns retain their defaults. Keep this SQL
 * frozen: using the current writer would couple historical fixtures to future
 * schema changes and fail before the migration being tested can run.
 */
export function insertLegacyRun(db: Db, run: LegacyRun): Run {
  db.stmt("INSERT INTO runs (id, task_id, thread_id, agent, model, effort, fast_mode, mode, permission_mode, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?)").run(
    run.id,
    run.taskId,
    run.threadId,
    run.agent,
    run.model,
    run.effort ?? null,
    Number(run.fastMode ?? false),
    run.mode,
    run.permissionMode,
    Date.now(),
  );
  return runs.get(db, run.id)!;
}
