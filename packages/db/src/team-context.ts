import { randomUUID } from "node:crypto";
import { TeamContextCheckpoint, TeamContextScope } from "@openorc/protocol";
import type { Db } from "./database.js";
import { teamRuntime } from "./team-runtime.js";

export type CreateTeamContextInput = TeamContextScope & Pick<TeamContextCheckpoint, "originExecutionId" | "reason" | "requestKey" | "seed">;
interface ContextRow {
  id: string;
  instance_id: string;
  execution_id: string | null;
  actor_id: string;
  origin_execution_id: string | null;
  epoch: number;
  reason: TeamContextCheckpoint["reason"];
  request_key: string;
  seed: string;
  created_at: number;
}

/** Ownership is read through the journal; runtime journal validation itself checks checkpoint references. */
function assertOwner(db: Db, context: TeamContextCheckpoint): void {
  if (!db.stmt("SELECT 1 FROM orchestration_team_instances WHERE id = ?").get(context.instanceId)) throw new Error("Context instance was not found.");
  if (context.originExecutionId === null) return;
  const execution = teamRuntime.get(db, context.originExecutionId);
  const actor = execution?.instanceId === context.instanceId ? execution.actors.find((item) => item.id === context.actorId) : undefined;
  if (!actor || (actor.id !== "lead" && teamRuntime.assignment(db, execution!.id, actor.id)?.taskId !== actor.taskId))
    throw new Error("Context actor must belong to its originating execution and instance.");
}
function decode(db: Db, row: ContextRow): TeamContextCheckpoint {
  const result = TeamContextCheckpoint.parse({
    id: row.id,
    instanceId: row.instance_id,
    executionId: row.execution_id,
    actorId: row.actor_id,
    originExecutionId: row.origin_execution_id,
    epoch: row.epoch,
    reason: row.reason,
    requestKey: row.request_key,
    seed: row.seed,
    createdAt: row.created_at,
  });
  assertOwner(db, result);
  return result;
}
function scoped(db: Db, scope: TeamContextScope, suffix: string, extra: string[] = []): TeamContextCheckpoint | null {
  const input = TeamContextScope.parse(scope);
  const row = db
    .stmt(`SELECT * FROM team_context_checkpoints WHERE instance_id = ? AND execution_id IS ? AND actor_id = ? ${suffix}`)
    .get(input.instanceId, input.executionId, input.actorId, ...extra) as unknown as ContextRow | undefined;
  return row ? decode(db, row) : null;
}

export const teamContexts = {
  create(db: Db, input: CreateTeamContextInput): TeamContextCheckpoint {
    const proposed = TeamContextCheckpoint.parse({ ...input, id: randomUUID(), epoch: 1, createdAt: Date.now() });
    return db.transaction(() => {
      assertOwner(db, proposed);
      const { instanceId, executionId, actorId, requestKey } = proposed;
      const previous = teamContexts.findRequest(db, { instanceId, executionId, actorId, requestKey });
      if (previous) {
        if (previous.reason !== proposed.reason || previous.seed !== proposed.seed || previous.originExecutionId !== proposed.originExecutionId)
          throw new Error("This context request key already identifies different recovery work.");
        return previous;
      }
      const latest = teamContexts.latest(db, { instanceId, executionId, actorId });
      const record = { ...proposed, epoch: (latest?.epoch ?? 0) + 1 };
      db.stmt(
        "INSERT INTO team_context_checkpoints (id, instance_id, execution_id, actor_id, origin_execution_id, epoch, reason, request_key, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(record.id, instanceId, executionId, actorId, record.originExecutionId, record.epoch, record.reason, requestKey, record.seed, record.createdAt);
      return record;
    });
  },
  latest(db: Db, scope: TeamContextScope): TeamContextCheckpoint | null {
    return scoped(db, scope, "ORDER BY epoch DESC LIMIT 1");
  },
  get(db: Db, id: string): TeamContextCheckpoint | null {
    const row = db.stmt("SELECT * FROM team_context_checkpoints WHERE id = ?").get(id) as unknown as ContextRow | undefined;
    return row ? decode(db, row) : null;
  },
  findRequest(db: Db, input: TeamContextScope & { requestKey: string }): TeamContextCheckpoint | null {
    const { requestKey, ...scope } = input;
    return scoped(db, scope, "AND request_key = ?", [requestKey]);
  },
  listForInstance(db: Db, instanceId: string): TeamContextCheckpoint[] {
    return (db.stmt("SELECT * FROM team_context_checkpoints WHERE instance_id = ? ORDER BY created_at, rowid").all(instanceId) as unknown as ContextRow[]).map((row) => decode(db, row));
  },
};
