import type { AgentEvent, SubagentStatus } from "@openorc/protocol";
import { mapNotification, type NotificationState } from "./notifications.js";

type Started = Extract<AgentEvent, { type: "subagent.started" }>;
type Details = Partial<Pick<Started, "parentSubagentId" | "toolCallId" | "prompt" | "agentType" | "model" | "effort">> & { title?: { text: string; priority: number }; path?: string };
interface Child {
  start: Started;
  titlePriority: number;
  state: NotificationState;
  turnId: string | null;
  status: SubagentStatus;
  reply: string | undefined;
  path?: string;
  stopRequested?: boolean;
  lastTurnId?: string;
}
interface Dependencies {
  runId: string;
  root(): string | null;
  activeTurn?(): string | null;
  emit(event: AgentEvent): void;
  request(method: string, params: unknown): Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const lifecycle = new Set(["turn/started", "turn/completed", "thread/closed"]);

function trimPending(queue: { method: string; params: unknown }[]): void {
  if (queue.length <= 128) return;
  let drop = queue.findIndex(({ method }) => /delta$/i.test(method));
  if (drop < 0) drop = queue.findIndex(({ method }) => !lifecycle.has(method));
  queue.splice(drop < 0 ? 0 : drop, 1);
}

function statusOf(value: unknown): SubagentStatus | undefined {
  switch (value) {
    case "pendingInit":
    case "running":
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "failed":
    case "notFound":
      return "failed";
    case "shutdown":
    case "interrupted":
      return "stopped";
    default:
      return undefined;
  }
}

/** Native children share a transport, but each has its own turn and notification mapper state. */
export class CodexSubagents {
  private readonly children = new Map<string, Child>();
  private readonly hydrated = new Set<string>();
  private readonly pending = new Map<string, { method: string; params: unknown }[]>();
  private closed = false;

  constructor(private readonly deps: Dependencies) {}

  observe(method: string, params: unknown): void {
    const p = record(params);
    if (method === "thread/started") {
      this.thread(record(p["thread"]));
      return;
    }
    const owner = text(p["threadId"]);
    if (!owner || (owner !== this.deps.root() && !this.children.has(owner))) return;
    if (method !== "item/started" && method !== "item/completed") return;
    const item = record(p["item"]);
    const parentSubagentId = owner === this.deps.root() ? undefined : owner;
    if (item["type"] === "subAgentActivity") this.activity(item, parentSubagentId);
    else if (item["type"] === "collabAgentToolCall") this.collaboration(item, parentSubagentId);
  }

  private activity(item: Record<string, unknown>, parentSubagentId: string | undefined): void {
    const id = text(item["agentThreadId"]);
    if (!id) return;
    this.register(
      id,
      {
        parentSubagentId,
        toolCallId: text(item["id"]),
        model: text(item["model"]),
        effort: text(item["reasoningEffort"]),
        path: text(item["agentPath"]),
        ...(text(item["agentPath"]) ? { title: { text: String(item["agentPath"]), priority: 2 } } : {}),
      },
      item["kind"] === "started",
    );
    if (item["kind"] === "completed") this.update(id, "completed");
    if (item["kind"] === "interrupted") this.update(id, "stopped");
  }

  private collaboration(item: Record<string, unknown>, parentSubagentId: string | undefined): void {
    const receivers = new Set([...strings(item["receiverThreadIds"]), ...Object.keys(record(item["agentsStates"]))]);
    const spawning = item["tool"] === "spawnAgent";
    const prompt = spawning ? text(item["prompt"]) : undefined;
    for (const id of receivers) {
      if (["sendInput", "resumeAgent", "followupTask"].includes(String(item["tool"]))) {
        const child = this.children.get(id);
        if (child) child.stopRequested = false;
      }
      this.register(
        id,
        {
          parentSubagentId,
          toolCallId: spawning ? text(item["id"]) : undefined,
          prompt,
          model: text(item["model"]),
          effort: text(item["reasoningEffort"]),
          ...(prompt ? { title: { text: prompt.split("\n")[0]!.slice(0, 100), priority: 1 } } : {}),
        },
        spawning,
      );
    }
    for (const [id, value] of Object.entries(record(item["agentsStates"]))) {
      const state = record(value);
      const status = statusOf(state["status"]);
      if (status) this.update(id, status, text(state["message"]));
    }
  }

  private thread(thread: Record<string, unknown>): void {
    const id = text(thread["id"]);
    const spawn = record(record(record(thread["source"])["subAgent"])["thread_spawn"]);
    const parent = text(spawn["parent_thread_id"]);
    if (!id || !parent || (parent !== this.deps.root() && !this.children.has(parent))) return;
    const nickname = text(thread["agentNickname"]) ?? text(spawn["agent_nickname"]);
    const role = text(thread["agentRole"]) ?? text(spawn["agent_role"]);
    const path = text(spawn["agent_path"]);
    const title = nickname ?? role ?? path;
    this.register(
      id,
      {
        parentSubagentId: parent === this.deps.root() ? undefined : parent,
        agentType: role,
        model: text(thread["model"]),
        path,
        ...(title ? { title: { text: title, priority: nickname || role ? 3 : 2 } } : {}),
      },
      true,
    );
  }

  private register(id: string, details: Details, spawning = false): void {
    if (id === this.deps.root()) return;
    const { title, path, ...fields } = details;
    let child = this.children.get(id);
    if (!child) {
      child = {
        start: { type: "subagent.started", runId: this.deps.runId, ts: Date.now(), subagentId: id, title: title?.text ?? "Subagent" },
        titlePriority: 0,
        state: { summaryIndex: new Map(), buffering: new Set() },
        turnId: null,
        status: spawning ? "running" : "completed",
        reply: undefined,
      };
      this.children.set(id, child);
    }
    const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    child.start = { ...child.start, ...defined };
    if (path) child.path = path;
    if (title && title.priority >= child.titlePriority) {
      child.start.title = title.text;
      child.titlePriority = title.priority;
    }
    this.deps.emit({ ...child.start, ts: Date.now() });
    const queued = this.pending.get(id);
    this.pending.delete(id);
    for (const notification of queued ?? []) this.route(notification.method, notification.params);
  }

  route(method: string, params: unknown): boolean {
    this.observe(method, params);
    const id = text(record(params)["threadId"]);
    if (!id || id === this.deps.root()) return false;
    if (!this.children.has(id)) {
      const queue = this.pending.get(id) ?? [];
      queue.push({ method, params });
      trimPending(queue);
      this.pending.set(id, queue);
      if (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value!);
      return true;
    }
    this.forward(method, params);
    return true;
  }

  forward(method: string, params: unknown): void {
    const p = record(params);
    const id = text(p["threadId"]);
    const child = id ? this.children.get(id) : undefined;
    if (!id || !child) return;
    if (method === "turn/started") {
      const turnId = text(record(p["turn"])["id"]);
      if (!turnId || child.lastTurnId === turnId) return;
      child.lastTurnId = turnId;
      if (child.stopRequested) return;
      child.turnId = turnId;
      child.reply = undefined;
      this.update(id, "running", undefined, true);
      void this.hydrate(id);
      return;
    }
    if (method === "turn/completed") {
      this.complete(id, record(p["turn"]));
      return;
    }
    if (method === "thread/closed") {
      child.turnId = null;
      if (child.status === "running") this.update(id, "stopped");
      return;
    }
    for (const event of mapNotification(this.deps.runId, method, params, child.state)) {
      if (event.type === "message.completed" && event.role === "assistant") child.reply = event.text;
      this.deps.emit({ ...event, subagentId: id });
      const progress = this.progress(event);
      if (progress) this.deps.emit({ type: "subagent.updated", runId: this.deps.runId, ts: event.ts, subagentId: id, progress });
    }
  }

  private complete(id: string, turn: Record<string, unknown>): void {
    const child = this.children.get(id);
    if (child?.turnId && text(turn["id"]) !== child.turnId) return;
    const error = text(record(turn["error"])["message"]);
    this.update(id, statusOf(turn["status"]) ?? "failed", error);
  }

  private progress(event: AgentEvent): string | undefined {
    if (event.type === "tool.started") return event.name;
    if (event.type === "activity.updated" && event.status === "running") return event.label;
    if (event.type === "thinking.started") return "Thinking";
    return undefined;
  }

  private update(id: string, status: SubagentStatus, result?: string, nativeTurn = false): void {
    const child = this.children.get(id);
    if (!child) return;
    if (status === "running" && !nativeTurn) return;
    if (status !== "running" && child.status !== "running") return;
    child.status = status;
    if (status !== "running") child.turnId = null;
    if (result) child.reply = result;
    this.deps.emit({
      type: "subagent.updated",
      runId: this.deps.runId,
      ts: Date.now(),
      subagentId: id,
      status,
      ...(status === "running" || status === "stopped" ? {} : { result: result ?? child.reply }),
    });
  }

  /** Launch activity omits the prompt and nickname in Codex 0.166. Read the first saved user item once. */
  private async hydrate(id: string): Promise<void> {
    if (this.hydrated.has(id)) return;
    this.hydrated.add(id);
    try {
      const result = record(await this.deps.request("thread/read", { threadId: id, includeTurns: false }));
      if (this.closed) return;
      this.thread(record(result["thread"]));
      if (this.children.get(id)?.start.prompt) return;
      const page = record(await this.deps.request("thread/items/list", { threadId: id, limit: 100, sortDirection: "asc" }));
      if (this.closed) return;
      const data = Array.isArray(page["data"]) ? page["data"] : [];
      for (const entry of data) {
        const item = record(record(entry)["item"]);
        if (item["type"] !== "userMessage") continue;
        const content = Array.isArray(item["content"]) ? item["content"] : [];
        const prompt = content
          .map((part) => text(record(part)["text"]) ?? "")
          .filter(Boolean)
          .join("\n");
        if (prompt) this.register(id, { prompt });
        return;
      }
    } catch {
      // Older and ephemeral provider threads may not expose history; their live stream still works.
    }
  }

  title(params: unknown): string | undefined {
    const id = text(record(params)["threadId"]);
    return id ? this.children.get(id)?.start.title : undefined;
  }

  nativeId(params: unknown): string | undefined {
    const id = text(record(params)["threadId"]);
    return id && id !== this.deps.root() ? id : undefined;
  }

  canStop(id: string): boolean {
    const child = this.children.get(id);
    return !this.closed && child?.status === "running" && Boolean(child.turnId);
  }

  async stop(id: string, reason?: "parent-stop"): Promise<void> {
    const child = this.children.get(id);
    if (!child?.turnId || !this.canStop(id)) return;
    child.stopRequested = true;
    try {
      await this.deps.request("turn/interrupt", { threadId: id, turnId: child.turnId });
    } catch (error) {
      child.stopRequested = false;
      throw error;
    }
    if (child.start.parentSubagentId || reason === "parent-stop") return;
    this.deps.emit({ type: "subagent.updated", runId: this.deps.runId, ts: Date.now(), subagentId: id, notice: `Stopped ${child.start.title}` });
    const expectedTurnId = this.deps.activeTurn?.();
    if (!expectedTurnId) return;
    void this.deps
      .request("turn/steer", {
        threadId: this.deps.root(),
        expectedTurnId,
        input: [{ type: "text", text: `I stopped the sub-agent ${child.path ?? child.start.title}. It will not report. Treat it as finished; do not wait for it or respawn it.` }],
      })
      .catch(() => undefined);
  }

  interrupt(): void {
    for (const [id, child] of this.children) {
      if (child.status !== "running") continue;
      child.stopRequested = true;
      if (!child.turnId) this.update(id, "stopped");
    }
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
  }
}
