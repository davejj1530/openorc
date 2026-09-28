import { TeamContextSeed } from "@openorc/protocol";
import type { Db } from "./database.js";

export interface TeamOrigin {
  instanceId: string;
  sourceThreadId: string;
  sourceInstanceId: string;
  sourceRunId: string | null;
  seed: string;
  createdAt: number;
}
export type CreateTeamOriginInput = Omit<TeamOrigin, "createdAt">;
interface OriginRow {
  instance_id: string;
  source_thread_id: string;
  source_instance_id: string;
  source_run_id: string | null;
  seed: string;
  created_at: number;
}

export const teamOrigins = {
  get(db: Db, instanceId: string): TeamOrigin | null {
    const row = db.stmt("SELECT * FROM team_origins WHERE instance_id=?").get(instanceId) as unknown as OriginRow | undefined;
    return row
      ? {
          instanceId: row.instance_id,
          sourceThreadId: row.source_thread_id,
          sourceInstanceId: row.source_instance_id,
          sourceRunId: row.source_run_id,
          seed: TeamContextSeed.parse(row.seed),
          createdAt: row.created_at,
        }
      : null;
  },
  create(db: Db, input: CreateTeamOriginInput): TeamOrigin {
    const seed = TeamContextSeed.parse(input.seed);
    if (!seed.trim() || [input.instanceId, input.sourceThreadId, input.sourceInstanceId].some((id) => !id.trim()) || (input.sourceRunId !== null && !input.sourceRunId.trim()))
      throw new Error("Fork context requires its destination, source identities and seed.");
    return db.transaction(() => {
      const previous = teamOrigins.get(db, input.instanceId);
      // Source deletion must not invalidate an acknowledged fork or its replay.
      if (previous) {
        if (previous.sourceThreadId !== input.sourceThreadId || previous.sourceInstanceId !== input.sourceInstanceId || previous.sourceRunId !== input.sourceRunId || previous.seed !== seed)
          throw new Error("This instance already has different fork context.");
        return previous;
      }
      const record = { ...input, seed, createdAt: Date.now() };
      db.stmt("INSERT INTO team_origins(instance_id,source_thread_id,source_instance_id,source_run_id,seed,created_at) VALUES(?,?,?,?,?,?)").run(
        record.instanceId,
        record.sourceThreadId,
        record.sourceInstanceId,
        record.sourceRunId,
        record.seed,
        record.createdAt,
      );
      return record;
    });
  },
};
