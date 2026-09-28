import { randomUUID } from "node:crypto";
import { ExecutionTarget, ScheduleLaunchSnapshot, type Schedule, type ScheduleFiringRecord } from "@openorc/protocol";
import type { Db } from "./database.js";
import { orchestration } from "./orchestration.js";

interface ScheduleRow {
  id: string;
  project_id: string;
  title: string;
  prompt: string;
  agent: Schedule["agent"];
  model: string | null;
  effort: string | null;
  mode: Schedule["mode"];
  permission_mode: Schedule["permissionMode"];
  workspace_mode: Schedule["workspaceMode"];
  execution_target: string | null;
  version: number;
  every_minutes: number;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number;
  last_thread_id: string | null;
  created_at: number;
  updated_at: number;
}
interface FiringRow {
  id: string;
  schedule_id: string;
  request_key: string;
  schedule_version: number;
  trigger: ScheduleFiringRecord["trigger"];
  scheduled_for: number | null;
  snapshot: string;
  state: ScheduleFiringRecord["state"];
  thread_id: string | null;
  execution_id: string | null;
  reason: string | null;
  created_at: number;
  finished_at: number | null;
}
function firingFromRow(row: FiringRow): ScheduleFiringRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    requestKey: row.request_key,
    scheduleVersion: row.schedule_version,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    snapshot: ScheduleLaunchSnapshot.parse(JSON.parse(row.snapshot)),
    state: row.state,
    threadId: row.thread_id,
    executionId: row.execution_id,
    reason: row.reason,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}
function fromRow(db: Db, row: ScheduleRow): Schedule {
  const executionTarget = row.execution_target ? ExecutionTarget.parse(JSON.parse(row.execution_target)) : null;
  const revision = executionTarget?.kind === "team" ? orchestration.getRevision(db, executionTarget.teamRevisionId) : null;
  const last = db.stmt("SELECT * FROM schedule_firings WHERE schedule_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(row.id) as unknown as FiringRow | undefined;
  const lastFire = last ? (({ scheduleId: _scheduleId, requestKey: _requestKey, scheduleVersion: _version, snapshot: _snapshot, ...view }) => view)(firingFromRow(last)) : null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    prompt: row.prompt,
    agent: row.agent,
    model: row.model,
    effort: row.effort,
    mode: row.mode,
    permissionMode: row.permission_mode,
    workspaceMode: row.workspace_mode,
    executionTarget,
    version: row.version,
    everyMinutes: row.every_minutes,
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastThreadId: row.last_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    team: revision ? { revision, archived: orchestration.get(db, revision.teamId)?.team.archivedAt !== null } : null,
    lastFire,
  };
}

export interface SchedulePatch {
  title?: string;
  prompt?: string;
  everyMinutes?: number;
  enabled?: boolean;
  model?: string | null;
  effort?: string | null;
  agent?: Schedule["agent"];
  mode?: Schedule["mode"];
  permissionMode?: Schedule["permissionMode"];
  workspaceMode?: Schedule["workspaceMode"];
  executionTarget?: Schedule["executionTarget"];
  expectedVersion?: number;
  lastRunAt?: number | null;
  nextRunAt?: number;
  lastThreadId?: string | null;
}
const columns = {
  title: "title",
  prompt: "prompt",
  everyMinutes: "every_minutes",
  enabled: "enabled",
  model: "model",
  effort: "effort",
  agent: "agent",
  mode: "mode",
  permissionMode: "permission_mode",
  workspaceMode: "workspace_mode",
  executionTarget: "execution_target",
  lastRunAt: "last_run_at",
  nextRunAt: "next_run_at",
  lastThreadId: "last_thread_id",
} satisfies Record<Exclude<keyof SchedulePatch, "expectedVersion">, string>;
const bookkeeping = new Set(["lastRunAt", "nextRunAt", "lastThreadId"]);

export const schedules = {
  list(db: Db, projectId?: string): Schedule[] {
    const rows = (projectId
      ? db.stmt("SELECT * FROM schedules WHERE project_id=? ORDER BY created_at").all(projectId)
      : db.stmt("SELECT * FROM schedules ORDER BY created_at").all()) as unknown as ScheduleRow[];
    return rows.map((row) => fromRow(db, row));
  },
  get(db: Db, id: string): Schedule | null {
    const row = db.stmt("SELECT * FROM schedules WHERE id=?").get(id) as unknown as ScheduleRow | undefined;
    return row ? fromRow(db, row) : null;
  },
  due(db: Db, at: number): Schedule[] {
    return (db.stmt("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at").all(at) as unknown as ScheduleRow[]).map((row) => fromRow(db, row));
  },
  insert(db: Db, input: Omit<ScheduleLaunchSnapshot, "executionTarget"> & { executionTarget?: Schedule["executionTarget"] }): Schedule {
    const s = ScheduleLaunchSnapshot.parse(input);
    const id = randomUUID(),
      time = Date.now();
    db.stmt(
      `INSERT INTO schedules (id,project_id,title,prompt,agent,model,effort,mode,permission_mode,workspace_mode,every_minutes,execution_target,team_revision_id,enabled,next_run_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    ).run(
      id,
      s.projectId,
      s.title,
      s.prompt,
      s.agent,
      s.model,
      s.effort,
      s.mode,
      s.permissionMode,
      s.workspaceMode,
      s.everyMinutes,
      s.executionTarget ? JSON.stringify(s.executionTarget) : null,
      s.executionTarget?.kind === "team" ? s.executionTarget.teamRevisionId : null,
      time + s.everyMinutes * 60_000,
      time,
      time,
    );
    return schedules.get(db, id)!;
  },
  update(db: Db, id: string, patch: SchedulePatch): Schedule {
    return db.transaction(() => {
      const current = schedules.get(db, id);
      if (!current) throw new Error(`schedule ${id} not found`);
      if (patch.expectedVersion !== undefined && current.version !== patch.expectedVersion) throw new Error("This schedule changed in another window. Reload before saving.");
      const sets: string[] = [],
        args: (string | number | null)[] = [];
      let changed = false;
      for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
        const value = patch[key];
        if (value === undefined) continue;
        const parsed = key === "executionTarget" && value !== null ? ExecutionTarget.parse(value) : value;
        if (JSON.stringify(parsed) === JSON.stringify(current[key])) continue;
        sets.push(`${columns[key]}=?`);
        args.push(scheduleColumnValue(key, parsed));
        if (!bookkeeping.has(key)) changed = true;
        if (key === "executionTarget") {
          const target = parsed as Schedule["executionTarget"];
          sets.push("team_revision_id=?");
          args.push(target?.kind === "team" ? target.teamRevisionId : null);
        }
      }
      if (sets.length === 0) return current;
      if (changed) sets.push("version=version+1");
      sets.push("updated_at=?");
      args.push(Date.now(), id);
      db.stmt(`UPDATE schedules SET ${sets.join(",")} WHERE id=?`).run(...args);
      return schedules.get(db, id)!;
    });
  },
  delete(db: Db, id: string): void {
    db.stmt("DELETE FROM schedules WHERE id=?").run(id);
  },
};

type Reservation = Pick<ScheduleFiringRecord, "scheduleId" | "requestKey" | "scheduleVersion" | "trigger" | "scheduledFor" | "snapshot">;
type Settlement = { state: Exclude<ScheduleFiringRecord["state"], "pending">; threadId?: string | null; executionId?: string | null; reason?: string | null };
/** Reservations precede async preflight; settlement composes with thread admission in one transaction. */
export const scheduleFirings = {
  get(db: Db, id: string): ScheduleFiringRecord | null {
    const row = db.stmt("SELECT * FROM schedule_firings WHERE id=?").get(id) as unknown as FiringRow | undefined;
    return row ? firingFromRow(row) : null;
  },
  findRequest(db: Db, scheduleId: string, requestKey: string): ScheduleFiringRecord | null {
    const row = db.stmt("SELECT * FROM schedule_firings WHERE schedule_id=? AND request_key=?").get(scheduleId, requestKey) as unknown as FiringRow | undefined;
    return row ? firingFromRow(row) : null;
  },
  /** Oldest first, including every historical thread that may have been continued manually. */
  list(db: Db, scheduleId: string): ScheduleFiringRecord[] {
    return (db.stmt("SELECT * FROM schedule_firings WHERE schedule_id=? ORDER BY created_at,rowid").all(scheduleId) as unknown as FiringRow[]).map(firingFromRow);
  },
  pending(db: Db): ScheduleFiringRecord[] {
    return (db.stmt("SELECT * FROM schedule_firings WHERE state='pending' ORDER BY created_at,rowid").all() as unknown as FiringRow[]).map(firingFromRow);
  },
  reserve(db: Db, input: Reservation): ScheduleFiringRecord {
    const snapshot = ScheduleLaunchSnapshot.parse(input.snapshot);
    return db.transaction(() => {
      const prior = scheduleFirings.findRequest(db, input.scheduleId, input.requestKey);
      if (prior) {
        if (
          prior.scheduleVersion !== input.scheduleVersion ||
          prior.trigger !== input.trigger ||
          prior.scheduledFor !== input.scheduledFor ||
          JSON.stringify(prior.snapshot) !== JSON.stringify(snapshot)
        )
          throw new Error("This schedule request key already belongs to different launch input.");
        return prior;
      }
      const schedule = schedules.get(db, input.scheduleId);
      if (!schedule || schedule.version !== input.scheduleVersion || JSON.stringify(ScheduleLaunchSnapshot.parse(schedule)) !== JSON.stringify(snapshot))
        throw new Error("This schedule changed before its launch could be reserved.");
      const id = randomUUID();
      db.stmt(
        `INSERT INTO schedule_firings (id,schedule_id,request_key,schedule_version,trigger,scheduled_for,snapshot,state,created_at)
        VALUES (?,?,?,?,?,?,?,'pending',?)`,
      ).run(id, input.scheduleId, input.requestKey, input.scheduleVersion, input.trigger, input.scheduledFor, JSON.stringify(snapshot), Date.now());
      return scheduleFirings.get(db, id)!;
    });
  },
  settle(db: Db, id: string, input: Settlement): ScheduleFiringRecord {
    return db.transaction(() => {
      const prior = scheduleFirings.get(db, id);
      if (!prior) throw new Error("Schedule launch receipt not found.");
      const threadId = input.threadId ?? null,
        executionId = input.executionId ?? null,
        reason = input.reason ?? null;
      if (prior.state !== "pending") {
        if (prior.state !== input.state || prior.threadId !== threadId || prior.executionId !== executionId || prior.reason !== reason)
          throw new Error("This schedule launch already has a different result.");
        return prior;
      }
      if (input.state === "started" && !threadId) throw new Error("A started schedule launch requires its admitted thread.");
      db.stmt("UPDATE schedule_firings SET state=?,thread_id=?,execution_id=?,reason=?,finished_at=? WHERE id=? AND state='pending'").run(input.state, threadId, executionId, reason, Date.now(), id);
      return scheduleFirings.get(db, id)!;
    });
  },
};

function scheduleColumnValue(key: string, value: unknown): string | number | null {
  if (key === "executionTarget") return value ? JSON.stringify(value) : null;
  if (typeof value === "boolean") return Number(value);
  return value as string | number | null;
}
