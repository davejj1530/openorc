import { randomUUID } from "node:crypto";
import { listEvents, runs, subagents, threads, type Db, type SubagentRecord } from "@openorc/db";
import type { RunHandle } from "@openorc/agents";
import { isSubagentThread, type AgentEvent, type Run, type Thread, type ThreadSummary, type Usage } from "@openorc/protocol";
import { titleFromPrompt } from "./thread-inputs.js";

type Started = Extract<AgentEvent, { type: "subagent.started" }>;
type Updated = Extract<AgentEvent, { type: "subagent.updated" }>;
const childStatus = { success: "completed", cancelled: "stopped", error: "failed", max_turns: "failed", budget_exceeded: "failed" } as const;
const runStatus = { running: "error", completed: "success", stopped: "cancelled", failed: "error", no_updates: "cancelled" } as const;
type Host = { run: Run; thread: Thread };
interface Dependencies {
  db: Db;
  emit(event: AgentEvent): void;
  invalidate(keys: string[]): void;
  handle(hostRunId: string): RunHandle | undefined;
  flush(): void;
  ended?(hostRunId: string, nativeId: string): void;
  tool?(hostRunId: string, toolCallId: string, nativeId: string): void;
}

/** Child runs hold history only. Their provider process and cost belong to the host. */
export class SubagentService {
  private readonly deleted = new Set<string>();
  constructor(private readonly deps: Dependencies) {}

  deleteFinished(threadId: string): void {
    const { db } = this.deps;
    const row = subagents.byThread(db, threadId);
    if (!row) throw new Error("Subagent not found.");
    if (row.status === "running" || subagents.hasWorkingDescendants(db, threadId)) throw new Error("Stop the running subagent before deleting it.");
    this.deps.flush();
    const remember = (id: string) => {
      const child = subagents.byThread(db, id);
      if (child) this.deleted.add(`${child.hostRunId}:${child.nativeId}`);
      for (const nested of threads.children(db, id)) if (isSubagentThread(nested)) remember(nested.id);
    };
    remember(threadId);
    threads.delete(db, threadId);
  }

  assertExecutable(target: { runId: string } | { threadId: string }): void {
    const child = "runId" in target ? subagents.byRun(this.deps.db, target.runId) : subagents.byThread(this.deps.db, target.threadId);
    if (child) throw new Error("A subagent thread is read-only. Continue in its parent thread.");
  }

  summary(threadId: string): ThreadSummary["subagent"] {
    const row = subagents.byThread(this.deps.db, threadId);
    if (!row) return undefined;
    const { status, agentType, toolCallId, startedAt, endedAt } = row;
    return { status, agentType, toolCallId, startedAt, endedAt, stoppable: status === "running" && (this.deps.handle(row.hostRunId)?.canStopSubagent(row.nativeId) ?? false) };
  }

  async stop(threadId: string): Promise<void> {
    const row = subagents.byThread(this.deps.db, threadId);
    if (!row) throw new Error("Subagent not found.");
    if (row.status !== "running") return;
    const handle = this.deps.handle(row.hostRunId);
    if (!handle?.canStopSubagent(row.nativeId)) throw new Error("This subagent cannot be stopped.");
    await handle.stopSubagent(row.nativeId);
  }

  running(hostRunId: string): number {
    return subagents.running(this.deps.db, hostRunId).length;
  }

  async interruptHost(hostRunId: string): Promise<void> {
    const handle = this.deps.handle(hostRunId);
    await Promise.all(
      subagents.running(this.deps.db, hostRunId).map(async (row) => {
        try {
          if (handle?.canStopSubagent(row.nativeId)) return await handle.stopSubagent(row.nativeId, "parent-stop");
          this.update(row, { type: "subagent.updated", runId: hostRunId, subagentId: row.nativeId, ts: Date.now(), status: "stopped" });
        } catch (error) {
          this.update(row, {
            type: "subagent.updated",
            runId: hostRunId,
            subagentId: row.nativeId,
            ts: Date.now(),
            status: "failed",
            error: `Could not stop: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }),
    );
  }

  route(host: Host, event: AgentEvent): boolean {
    if (event.type === "raw" || !event.subagentId) return false;
    if (this.deleted.has(`${host.run.id}:${event.subagentId}`)) return true;
    const row = this.ensure(host, event.subagentId, event.ts, event.type === "subagent.started" ? event : undefined);
    if (row.hostRunId !== host.run.id) return true;
    if (event.type === "tool.started") this.deps.tool?.(host.run.id, event.toolCallId, row.nativeId);
    if (event.type === "subagent.started") this.start(host, row, event);
    else if (event.type === "subagent.updated") this.update(row, event);
    else this.content(row, event);
    return true;
  }

  private ensure(host: Host, nativeId: string, ts: number, start?: Started): SubagentRecord {
    const found = subagents.byNative(this.deps.db, host.thread.id, nativeId);
    if (found) {
      if (found.hostRunId === host.run.id || runs.get(this.deps.db, host.run.id)?.endedAt !== null || (runs.get(this.deps.db, found.hostRunId)?.startedAt ?? 0) > host.run.startedAt) return found;
      return subagents.update(this.deps.db, { ...found, hostRunId: host.run.id });
    }
    const parent = start?.parentSubagentId && start.parentSubagentId !== nativeId ? this.ensure(host, start.parentSubagentId, ts) : null;
    const row = this.deps.db.transaction(() => {
      const thread = threads.insert(this.deps.db, {
        projectId: host.thread.projectId,
        title: titleFromPrompt(start?.title || "Subagent"),
        agent: host.run.agent,
        model: start?.model ?? host.run.model,
        effort: start?.effort ?? host.run.effort,
        mode: host.run.mode,
        permissionMode: host.run.permissionMode,
        claudeAccountId: host.run.claudeAccountId,
        workspaceMode: host.thread.workspaceMode,
        createdAt: ts,
      });
      threads.update(this.deps.db, thread.id, {
        parentThreadId: parent?.threadId ?? host.thread.id,
        parentRelation: "subagent",
        workingDirectory: host.run.workingDirectory ?? host.thread.workingDirectory,
        worktreePath: host.thread.worktreePath,
        branch: host.thread.branch,
        baseSha: host.thread.baseSha,
        baseBranch: host.thread.baseBranch,
      });
      const run = runs.insert(this.deps.db, {
        id: randomUUID(),
        threadId: thread.id,
        taskId: null,
        agent: thread.agent,
        model: thread.model,
        effort: thread.effort,
        mode: thread.mode,
        permissionMode: thread.permissionMode,
        claudeAccountId: thread.claudeAccountId,
        workingDirectory: host.run.workingDirectory ?? undefined,
      });
      runs.update(this.deps.db, run.id, { state: "running" });
      return subagents.insert(this.deps.db, {
        threadId: thread.id,
        runId: run.id,
        hostRunId: host.run.id,
        rootThreadId: host.thread.id,
        nativeId,
        toolCallId: start?.toolCallId ?? null,
        taskId: null,
        agentType: start?.agentType ?? null,
        prompt: start?.prompt ?? null,
        status: "running",
        result: null,
        startedAt: ts,
        endedAt: null,
      });
    });
    this.prompt(row);
    this.deps.emit({ type: "turn.started", runId: row.runId, ts, turnId: this.turnId(row) });
    this.changed(row);
    return row;
  }

  private start(host: Host, previous: SubagentRecord, event: Started): void {
    let parentId = threads.get(this.deps.db, previous.threadId)?.parentThreadId ?? host.thread.id;
    if (event.parentSubagentId && event.parentSubagentId !== previous.nativeId) parentId = this.ensure(host, event.parentSubagentId, event.ts).threadId;
    // A malformed provider relationship must not introduce a cycle into navigation or recursive deletion.
    for (let ancestor = threads.get(this.deps.db, parentId); ancestor; ancestor = ancestor.parentThreadId ? threads.get(this.deps.db, ancestor.parentThreadId) : null) {
      if (ancestor.id === previous.threadId) throw new Error("A subagent cannot be its own ancestor.");
    }
    threads.update(this.deps.db, previous.threadId, {
      parentThreadId: parentId,
      parentRelation: "subagent",
      title: event.title && event.title !== "Subagent" ? titleFromPrompt(event.title) : undefined,
      model: event.model,
      effort: event.effort,
    });
    runs.update(this.deps.db, previous.runId, { model: event.model, effort: event.effort });
    const row = subagents.update(this.deps.db, {
      ...previous,
      toolCallId: event.toolCallId ?? previous.toolCallId,
      agentType: event.agentType ?? previous.agentType,
      prompt: event.prompt ?? previous.prompt,
    });
    if (row.prompt !== previous.prompt) this.prompt(row);
    this.deps.emit({ ...event, runId: this.parentRunId(row), threadId: row.threadId });
    this.changed(row);
  }

  private update(previous: SubagentRecord, event: Updated, touch = true): void {
    if (event.status === "stopped") event = { ...event, result: undefined, error: undefined };
    const row = this.deps.db.transaction(() => this.persistUpdate(previous, event));
    this.deps.emit({ ...event, runId: this.parentRunId(row), threadId: row.threadId });
    this.changed(row, touch);
  }

  private persistUpdate(previous: SubagentRecord, event: Updated): SubagentRecord {
    const status = event.status ?? previous.status;
    const terminal = status !== "running";
    const row = subagents.update(this.deps.db, {
      ...previous,
      status,
      taskId: event.taskId ?? previous.taskId,
      result: status === "stopped" || (status === "running" && previous.status !== "running") ? null : (event.result ?? event.error ?? previous.result),
      startedAt: status === "running" && previous.status !== "running" ? event.ts : previous.startedAt,
      endedAt: terminal ? (previous.endedAt ?? event.ts) : null,
    });
    if (previous.status !== status) {
      if (terminal) this.finish(row, event.ts, event.error);
      else {
        runs.update(this.deps.db, row.runId, { state: "running", endedAt: null, error: null, resultText: null });
        this.deps.emit({ type: "turn.started", runId: row.runId, ts: event.ts, turnId: this.turnId(row) });
      }
    } else if (row.result !== previous.result) runs.update(this.deps.db, row.runId, { resultText: row.result });
    return row;
  }

  private content(row: SubagentRecord, event: Exclude<AgentEvent, Started | Updated>): void {
    const { subagentId: _nativeId, ...content } = event;
    let routed: AgentEvent = { ...content, runId: row.runId };
    if (routed.type === "usage.updated") {
      const usage = this.withoutCost(routed.usage);
      runs.update(this.deps.db, row.runId, { usage: { ...runs.get(this.deps.db, row.runId)?.usage, ...usage } });
      routed = { ...routed, usage };
    } else if (routed.type === "context.updated") {
      const usage = runs.get(this.deps.db, row.runId)?.usage;
      runs.update(this.deps.db, row.runId, { usage: { inputTokens: 0, outputTokens: 0, ...usage, contextTokens: routed.contextTokens, contextWindow: routed.contextWindow } });
    } else if (routed.type === "turn.completed" || routed.type === "session.completed") {
      if (routed.type === "turn.completed" && routed.usage) runs.update(this.deps.db, row.runId, { usage: { ...runs.get(this.deps.db, row.runId)?.usage, ...this.withoutCost(routed.usage) } });
      this.update(row, {
        type: "subagent.updated",
        runId: row.hostRunId,
        subagentId: row.nativeId,
        ts: routed.ts,
        status: childStatus[routed.status],
        ...(routed.type === "turn.completed" ? { result: routed.resultText } : {}),
      });
      return;
    } else if (routed.type === "turn.started") {
      this.update(row, { type: "subagent.updated", runId: row.hostRunId, subagentId: row.nativeId, ts: routed.ts, status: "running" });
      return;
    } else if (routed.type === "message.completed" && routed.role === "assistant") {
      runs.update(this.deps.db, row.runId, { resultText: routed.text });
    }
    this.deps.emit(routed);
  }

  private withoutCost({ costUsd: _cost, ...usage }: Usage): Usage {
    return usage;
  }

  private finish(row: SubagentRecord, ts: number, error?: string): void {
    const status = runStatus[row.status];
    const resultText = row.status === "stopped" ? undefined : (row.result ?? runs.get(this.deps.db, row.runId)?.resultText ?? undefined);
    runs.update(this.deps.db, row.runId, { state: status, endedAt: ts, resultText: resultText ?? null, error: error ?? (row.status === "failed" ? row.result : null) });
    this.deps.emit({
      type: "turn.completed",
      runId: row.runId,
      ts,
      turnId: this.turnId(row),
      status,
      resultText,
      observationEnded: row.status === "no_updates" || undefined,
      durationMs: Math.max(0, ts - row.startedAt),
    });
    this.deps.ended?.(row.hostRunId, row.nativeId);
  }

  stopHost(hostRunId: string, ts = Date.now(), touch = true): void {
    for (const row of subagents.running(this.deps.db, hostRunId)) this.update(row, { type: "subagent.updated", runId: hostRunId, subagentId: row.nativeId, ts, status: "stopped" }, touch);
  }

  recoverInterrupted(): void {
    this.deps.flush();
    this.removeEmptyPhantoms();
    for (const hostRunId of new Set(subagents.running(this.deps.db).map((row) => row.hostRunId))) this.stopHost(hostRunId, Date.now(), false);
  }

  private removeEmptyPhantoms(): void {
    const db = this.deps.db;
    const candidates = db
      .stmt(
        `SELECT s.thread_id FROM subagents s JOIN threads t ON t.id = s.thread_id
      WHERE t.parent_relation = 'subagent' AND coalesce(s.tool_call_id, '') = '' AND coalesce(s.task_id, '') = ''
      AND coalesce(s.agent_type, '') = '' AND coalesce(s.prompt, '') = '' AND coalesce(s.result, '') = ''
      AND NOT EXISTS (SELECT 1 FROM threads child WHERE child.parent_thread_id = s.thread_id)`,
      )
      .all();
    for (const candidate of candidates) {
      const id = String(candidate.thread_id);
      const history = runs.listForThread(db, id).flatMap((run) => listEvents(db, run.id, { includeRaw: true, limit: -1 }));
      if (
        history.every(
          (event) =>
            (event.type === "message.completed" && event.messageId === `subagent-prompt:${id}` && event.role === "user" && event.text === "") ||
            event.type === "turn.started" ||
            (event.type === "turn.completed" && !event.resultText) ||
            (event.type === "tool.updated" && /^Running for \d+s$/.test(event.progress ?? "") && event.input === undefined && event.mcp === undefined),
        )
      )
        db.transaction(() => {
          subagents.removeCards(db, id);
          threads.delete(db, id);
        });
    }
  }

  private prompt(row: SubagentRecord): void {
    this.deps.emit({ type: "message.completed", runId: row.runId, ts: row.startedAt, messageId: `subagent-prompt:${row.threadId}`, role: "user", text: row.prompt ?? "" });
  }

  private turnId(row: SubagentRecord): string {
    return `subagent:${row.nativeId}`;
  }

  private parentRunId(row: SubagentRecord): string {
    const thread = threads.get(this.deps.db, row.threadId);
    return thread?.parentThreadId ? (subagents.byThread(this.deps.db, thread.parentThreadId)?.runId ?? row.hostRunId) : row.hostRunId;
  }

  private changed(row: SubagentRecord, touch = true): void {
    const keys = ["threads", `runs:thread:${row.threadId}`, `thread:${row.threadId}`];
    for (let thread = threads.get(this.deps.db, row.threadId); thread?.parentThreadId; thread = threads.get(this.deps.db, thread.parentThreadId)) {
      keys.push(`thread:${thread.parentThreadId}`);
      if (touch) threads.touch(this.deps.db, thread.parentThreadId);
      if (!isSubagentThread(thread)) break;
    }
    if (touch) threads.touch(this.deps.db, row.threadId);
    this.deps.invalidate(keys);
  }
}
