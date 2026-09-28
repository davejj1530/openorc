import { runs, type Db, type LedgerWriter } from "@openorc/db";
import type { TaskCard } from "@openorc/mcp";
import type { AgentEvent, Run } from "@openorc/protocol";
import type { LiveRun, PendingApproval } from "./run-types.js";

type ProgressState = NonNullable<TaskCard["activity"]>["state"];

/** Projects the latest task execution from durable events and the current live process. */
export class RunProgress {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerWriter,
    private readonly live: ReadonlyMap<string, LiveRun>,
    private readonly pending: () => PendingApproval[],
  ) {}

  taskProgress(taskId: string): TaskCard["activity"] {
    const related = this.db
      .stmt(
        `SELECT id FROM runs WHERE task_id = ?
      OR id IN (SELECT execution_run_id FROM task_comment_attempts WHERE task_id = ? AND execution_run_id IS NOT NULL)
      OR id IN (SELECT json_extract(metadata, '$.runId') FROM audit_events WHERE action = 'task.start' AND resource_id = ?)
      ORDER BY started_at DESC LIMIT 1`,
      )
      .get(taskId, taskId, taskId) as { id: string } | undefined;
    const run = related ? runs.get(this.db, related.id) : null;
    if (!run) return null;
    this.ledger.flush();
    const rows = this.db
      .stmt(
        "SELECT COALESCE(a.content, e.payload) AS payload FROM events e LEFT JOIN artifacts a ON a.event_id=e.id AND a.kind='payload' WHERE e.run_id=? AND e.kind IN ('message.delta','message.completed','tool.started','tool.completed') ORDER BY e.seq DESC LIMIT 128",
      )
      .all(run.id) as { payload: string }[];
    const display = this.latestDisplay(rows, run.startedAt);
    const pending = this.pending().find((approval) => approval.runId === run.id);
    const state = this.progressState(run, pending);
    return {
      runId: run.id,
      state,
      latestMessage: display.latestMessage ?? run.resultText ?? run.error,
      lastAction: display.lastAction,
      waitingFor: pending?.detail ?? null,
      updatedAt: run.endedAt ?? display.updatedAt,
    };
  }

  private latestDisplay(rows: { payload: string }[], startedAt: number): { latestMessage: string | null; lastAction: string | null; updatedAt: number } {
    let latestMessage: string | null = null;
    let messageId: string | null = null;
    let lastAction: string | null = null;
    let updatedAt = startedAt;
    for (const row of rows.reverse()) {
      const event = JSON.parse(row.payload) as AgentEvent;
      updatedAt = event.ts;
      if ((event.type === "message.delta" || event.type === "message.completed") && event.role === "assistant") {
        if (event.type === "message.completed") latestMessage = event.text;
        else latestMessage = (messageId === event.messageId ? (latestMessage ?? "") : "") + event.text;
        latestMessage = latestMessage.slice(-2400);
        messageId = event.messageId;
      }
      if (event.type === "tool.started") lastAction = `Running ${event.name}`;
      if (event.type === "tool.completed") lastAction = event.isError ? "A tool reported an error" : "Finished the last tool call";
    }
    return { latestMessage, lastAction, updatedAt };
  }

  private progressState(run: Run, pending: PendingApproval | undefined): ProgressState {
    if (run.state === "error") return "failed";
    if (run.state === "cancelled") return "cancelled";
    if (run.state === "success") return "completed";
    if (pending) return "waiting";
    const live = this.live.get(run.id);
    if (live && !live.busy) return "idle";
    return "working";
  }
}
