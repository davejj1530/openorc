import { SubagentStatus } from "@openorc/protocol";
import { z } from "zod";
import type { Db } from "./database.js";
import { redact } from "./redact.js";

const SubagentRecord = z.object({
  threadId: z.string(),
  runId: z.string(),
  hostRunId: z.string(),
  rootThreadId: z.string(),
  nativeId: z.string(),
  toolCallId: z.string().nullable(),
  taskId: z.string().nullable(),
  agentType: z.string().nullable(),
  prompt: z.string().nullable(),
  status: SubagentStatus,
  result: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type SubagentRecord = z.infer<typeof SubagentRecord>;
const columns = `thread_id AS threadId, run_id AS runId, host_run_id AS hostRunId, root_thread_id AS rootThreadId, native_id AS nativeId,
  tool_call_id AS toolCallId, task_id AS taskId, agent_type AS agentType, prompt, status, result,
  started_at AS startedAt, ended_at AS endedAt`;
const read = (row: unknown): SubagentRecord | null => (row ? SubagentRecord.parse(row) : null);

export const subagents = {
  removeCards(db: Db, threadId: string): void {
    db.stmt(
      `DELETE FROM events WHERE id IN (
      SELECT e.id FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
      WHERE e.kind IN ('subagent.started', 'subagent.updated') AND json_extract(coalesce(a.content, e.payload), '$.threadId') = ?
    )`,
    ).run(threadId);
  },
  forRoot(db: Db, rootThreadId: string): SubagentRecord[] {
    return db
      .stmt(`SELECT ${columns} FROM subagents WHERE root_thread_id = ?`)
      .all(rootThreadId)
      .map((row) => SubagentRecord.parse(row));
  },
  byNative(db: Db, rootThreadId: string, nativeId: string): SubagentRecord | null {
    return read(db.stmt(`SELECT ${columns} FROM subagents WHERE root_thread_id = ? AND native_id = ? ORDER BY started_at, thread_id LIMIT 1`).get(rootThreadId, nativeId));
  },
  byRun(db: Db, runId: string): SubagentRecord | null {
    return read(db.stmt(`SELECT ${columns} FROM subagents WHERE thread_id = (SELECT thread_id FROM runs WHERE id = ?)`).get(runId));
  },
  byThread(db: Db, threadId: string): SubagentRecord | null {
    return read(db.stmt(`SELECT ${columns} FROM subagents WHERE thread_id = ?`).get(threadId));
  },
  hasWorkingDescendants(db: Db, threadId: string): boolean {
    return Boolean(
      db
        .stmt(
          `WITH RECURSIVE children(id) AS (
      SELECT id FROM threads WHERE parent_thread_id = ?
      UNION SELECT t.id FROM threads t JOIN children c ON t.parent_thread_id = c.id
    ) SELECT 1 FROM subagents s JOIN children c ON c.id = s.thread_id WHERE s.status = 'running' LIMIT 1`,
        )
        .get(threadId),
    );
  },
  running(db: Db, hostRunId?: string): SubagentRecord[] {
    const rows = hostRunId
      ? db.stmt(`SELECT ${columns} FROM subagents WHERE status = 'running' AND host_run_id = ?`).all(hostRunId)
      : db.stmt(`SELECT ${columns} FROM subagents WHERE status = 'running'`).all();
    return rows.map((row) => SubagentRecord.parse(row));
  },
  insert(db: Db, row: SubagentRecord): SubagentRecord {
    db.stmt(
      `INSERT INTO subagents (thread_id, run_id, host_run_id, root_thread_id, native_id, tool_call_id, task_id, agent_type, prompt, status, result, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.threadId,
      row.runId,
      row.hostRunId,
      row.rootThreadId,
      row.nativeId,
      row.toolCallId,
      row.taskId,
      row.agentType,
      row.prompt === null ? null : redact(row.prompt).text,
      row.status,
      row.result === null ? null : redact(row.result).text,
      row.startedAt,
      row.endedAt,
    );
    return subagents.byThread(db, row.threadId)!;
  },
  update(db: Db, row: SubagentRecord): SubagentRecord {
    db.stmt(`UPDATE subagents SET host_run_id = ?, started_at = ?, tool_call_id = ?, task_id = ?, agent_type = ?, prompt = ?, status = ?, result = ?, ended_at = ? WHERE thread_id = ?`).run(
      row.hostRunId,
      row.startedAt,
      row.toolCallId,
      row.taskId,
      row.agentType,
      row.prompt === null ? null : redact(row.prompt).text,
      row.status,
      row.result === null ? null : redact(row.result).text,
      row.endedAt,
      row.threadId,
    );
    return subagents.byThread(db, row.threadId)!;
  },
};
