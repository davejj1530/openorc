import type { AgentEvent, RunSpec, SubagentStatus } from "@openorc/protocol";
import { contentText, isRecord, num, str } from "./stream-values.js";

type Started = Extract<AgentEvent, { type: "subagent.started" }>;

interface Launch {
  start: Started;
  background: boolean;
  taskId: string | null;
  status: SubagentStatus;
  nested: boolean;
  inline: boolean;
  promptRead?: boolean;
  streamPromptRead?: boolean;
  resumed?: boolean;
  nativeRunId?: string;
  retiredRuns?: Set<string>;
  dormant?: boolean;
  readAfter?: number;
  stopRequested?: boolean;
}

export class ClaudeSubagents {
  private readonly launches = new Map<string, Launch>();
  private readonly taskAgents = new Map<string, string>();
  private readonly observed = new Set<string>();
  private readonly aliases = new Map<string, string>();
  private readonly pendingTasks = new Map<string, { msg: Record<string, unknown>; ts: number }[]>();

  constructor(private readonly runId: string) {}

  restore(history: NonNullable<RunSpec["resumedSubagents"]>): void {
    for (const entry of history) {
      this.taskAgents.set(entry.taskId, entry.nativeId);
      this.launches.set(entry.nativeId, {
        start: {
          type: "subagent.started",
          runId: this.runId,
          ts: entry.endedAt,
          subagentId: entry.nativeId,
          toolCallId: entry.nativeId,
          title: entry.title,
          parentSubagentId: entry.parentSubagentId,
        },
        taskId: entry.taskId,
        status: "completed",
        background: true,
        nested: Boolean(entry.parentSubagentId),
        inline: false,
        dormant: true,
        promptRead: true,
        streamPromptRead: true,
        resumed: true,
        readAfter: entry.endedAt,
      });
    }
  }

  identity(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  known(id: string): boolean {
    return this.launches.has(this.identity(id));
  }

  accepts(id: string, msg: Record<string, unknown>): boolean {
    const launch = this.launches.get(this.identity(id));
    const run = str(msg["run_id"]);
    return !run || !launch?.nativeRunId || run === launch.nativeRunId;
  }

  observe(nativeId: string): void {
    this.observed.add(nativeId);
    const launch = this.launches.get(nativeId);
    if (launch) launch.inline = true;
  }

  launch(id: string, rawInput: unknown, parent: string | null, ts: number, out: AgentEvent[]): void {
    const input = isRecord(rawInput) ? rawInput : {};
    const start: Started = {
      type: "subagent.started",
      runId: this.runId,
      ts,
      subagentId: id,
      toolCallId: id,
      title: str(input["description"]) ?? "Subagent",
      prompt: str(input["prompt"]) ?? undefined,
      agentType: str(input["subagent_type"]) ?? undefined,
      model: str(input["model"]) ?? undefined,
      effort: str(input["effort"]) ?? undefined,
      background: input["run_in_background"] === true,
      parentSubagentId: parent ?? undefined,
    };
    if (!this.launches.has(id)) this.launches.set(id, { start, background: start.background === true, taskId: null, status: "running", nested: Boolean(parent), inline: this.observed.has(id) });
    out.push(start);
    const pending = this.pendingTasks.get(id);
    this.pendingTasks.delete(id);
    for (const event of pending ?? []) this.task(event.msg, event.ts, out);
  }

  task(msg: Record<string, unknown>, ts: number, out: AgentEvent[], tailing = false): boolean {
    const subtype = str(msg["subtype"]);
    if (!subtype || !["task_started", "task_progress", "task_notification", "task_updated"].includes(subtype)) return false;
    if (msg["skip_transcript"] === true || msg["ambient"] === true) return true;
    const found = this.findTask(msg, ts, out);
    if (!found) return this.holdTask(msg, ts, tailing);
    if (found.launch.dormant && subtype !== "task_started") return true;
    const nativeRunId = str(msg["run_id"]);
    if (nativeRunId && found.launch.retiredRuns?.has(nativeRunId)) return true;
    if (subtype !== "task_started" && !this.accepts(found.nativeId, msg)) return true;
    if (found.launch.stopRequested && subtype !== "task_started") return true;
    this.updateTask(found, subtype, msg, ts, out);
    return true;
  }

  private holdTask(msg: Record<string, unknown>, ts: number, tailing: boolean): boolean {
    const id = str(msg["tool_use_id"]);
    if (!id || !((tailing && msg["task_type"] === "local_agent") || this.pendingTasks.has(id))) return false;
    const pending = this.pendingTasks.get(id) ?? [];
    pending.push({ msg, ts });
    if (pending.length > 32) pending.shift();
    this.pendingTasks.set(id, pending);
    if (this.pendingTasks.size > 256) this.pendingTasks.delete(this.pendingTasks.keys().next().value!);
    return true;
  }

  private findTask(msg: Record<string, unknown>, ts: number, out: AgentEvent[]): { nativeId: string; launch: Launch; taskId: string | null } | null {
    const taskId = str(msg["task_id"]);
    const toolId = str(msg["tool_use_id"]);
    const known = toolId ? this.identity(toolId) : undefined;
    const nativeId = known && this.launches.has(known) ? known : ((taskId ? this.taskAgents.get(taskId) : undefined) ?? known);
    if (!nativeId) return null;
    if (!this.launches.has(nativeId) && msg["subtype"] === "task_started") this.discoverTask(nativeId, msg, ts, out);
    const launch = this.launches.get(nativeId);
    if (launch && toolId && toolId !== nativeId) this.aliases.set(toolId, nativeId);
    return launch ? { nativeId, launch, taskId } : null;
  }

  private discoverTask(nativeId: string, msg: Record<string, unknown>, ts: number, out: AgentEvent[]): void {
    const parentTaskId = str(msg["parent_task_id"]);
    const parent = parentTaskId ? this.taskAgents.get(parentTaskId) : undefined;
    if (!this.observed.has(nativeId) && !(parent && msg["task_type"] === "local_agent")) return;
    this.launch(nativeId, { description: msg["description"], prompt: msg["prompt"], subagent_type: msg["subagent_type"], run_in_background: msg["is_backgrounded"] }, parent ?? null, ts, out);
  }

  private updateTask({ nativeId, launch, taskId }: { nativeId: string; launch: Launch; taskId: string | null }, subtype: string, msg: Record<string, unknown>, ts: number, out: AgentEvent[]): void {
    if (subtype === "task_updated") {
      const patch = msg["patch"];
      if (isRecord(patch) && patch["is_backgrounded"] === true) launch.background = true;
      return;
    }
    if (taskId) {
      launch.taskId = taskId;
      this.taskAgents.set(taskId, nativeId);
    }
    if (subtype === "task_started") {
      this.startedTask(nativeId, launch, taskId, msg, ts, out);
    } else if (subtype === "task_progress") {
      if (launch.status === "running")
        out.push({ type: "subagent.updated", runId: this.runId, ts, subagentId: nativeId, progress: str(msg["description"]) ?? str(msg["last_tool_name"]) ?? undefined });
    } else {
      const status = msg["status"];
      launch.status = status === "completed" || status === "stopped" ? status : "failed";
      out.push({ type: "subagent.updated", runId: this.runId, ts, subagentId: nativeId, status: launch.status, result: launch.status === "stopped" ? undefined : (str(msg["summary"]) ?? undefined) });
    }
  }

  private acceptStart(launch: Launch, nativeRunId: string | null): boolean {
    if (launch.stopRequested && (!nativeRunId || !launch.nativeRunId || nativeRunId === launch.nativeRunId)) {
      if (nativeRunId) launch.nativeRunId = nativeRunId;
      return false;
    }
    if (nativeRunId && launch.nativeRunId === nativeRunId && launch.status !== "running") return false;
    return true;
  }

  private startedTask(nativeId: string, launch: Launch, taskId: string | null, msg: Record<string, unknown>, ts: number, out: AgentEvent[]): void {
    const nativeRunId = str(msg["run_id"]);
    if (!this.acceptStart(launch, nativeRunId)) return;
    if (nativeRunId && nativeRunId !== launch.nativeRunId) {
      if (launch.nativeRunId) (launch.retiredRuns ??= new Set()).add(launch.nativeRunId);
      launch.nativeRunId = nativeRunId;
    }
    if (launch.status !== "running") {
      launch.inline = false;
      launch.resumed = true;
      launch.promptRead = true;
    }
    if (launch.dormant) {
      launch.dormant = false;
      out.push({ ...launch.start, ts });
    }
    launch.status = "running";
    launch.stopRequested = false;
    if ((num(msg["spawn_depth"]) ?? 0) > 1) launch.nested = true;
    if (msg["is_backgrounded"] === true) launch.background = true;
    out.push({ type: "subagent.updated", runId: this.runId, ts, subagentId: nativeId, taskId: taskId ?? undefined, status: launch.status });
  }

  result(id: string, output: unknown, isError: boolean, ts: number, out: AgentEvent[]): void {
    const launch = this.launches.get(id);
    if (!launch || launch.background || launch.status !== "running") return;
    launch.status = isError ? "failed" : "completed";
    let result: string | undefined;
    if (typeof output === "string") result = output;
    else if (Array.isArray(output))
      result = output
        .filter(isRecord)
        .map((part) => str(part["text"]) ?? "")
        .join("\n");
    out.push({ type: "subagent.updated", runId: this.runId, ts, subagentId: id, status: launch.status, result });
  }

  taskId(nativeId: string): string | null {
    const launch = this.launches.get(nativeId);
    return launch?.status === "running" ? launch.taskId : null;
  }

  stopped(nativeId?: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const [id, launch] of this.launches) {
      if ((nativeId && id !== nativeId) || launch.status !== "running") continue;
      launch.stopRequested = true;
      launch.status = "stopped";
      out.push({ type: "subagent.updated", runId: this.runId, ts: Date.now(), subagentId: id, status: "stopped" });
    }
    return out;
  }

  duplicatePrompt(nativeId: string, text: string): boolean {
    const launch = this.launches.get(nativeId);
    if (!launch || launch.resumed || launch.streamPromptRead) return false;
    launch.streamPromptRead = true;
    launch.promptRead = true;
    return text.trim() === launch.start.prompt?.trim();
  }

  transcriptTargets(): { agentId: string; subagentId: string; finished: boolean }[] {
    return [...this.launches.values()].flatMap((launch) =>
      !launch.dormant && launch.nested && launch.taskId ? [{ agentId: launch.taskId, subagentId: launch.start.subagentId, finished: launch.status !== "running" || launch.inline }] : [],
    );
  }

  transcriptMessage(agentId: string, msg: Record<string, unknown>, ts: number, out: AgentEvent[]): Record<string, unknown> | null {
    const nativeId = this.taskAgents.get(agentId);
    const launch = nativeId ? this.launches.get(nativeId) : undefined;
    if (!launch || launch.inline || !isRecord(msg["message"]) || !["assistant", "user"].includes(String(msg["type"]))) return null;
    if (launch.readAfter !== undefined && ts <= launch.readAfter) return null;
    const message = msg["message"];
    const text = contentText(message["content"]);
    if (msg["type"] === "user" && text && !launch.promptRead) {
      launch.promptRead = true;
      launch.start = { ...launch.start, prompt: text };
      out.push({ ...launch.start, ts });
      return null;
    }
    return { ...msg, parent_tool_use_id: launch.start.subagentId };
  }
}
