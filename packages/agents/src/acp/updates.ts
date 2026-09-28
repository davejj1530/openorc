import type { ContentBlock, PlanEntry, SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@openorc/protocol";

/** Context use the agent reported since the turn began; folded into the turn's usage. */
export interface ContextReport {
  used: number;
  size: number;
  costUsd?: number;
}

/** What a finished turn produced, once everything mid-stream is closed. */
export interface TurnSummary {
  events: AgentEvent[];
  /** Every assistant message of the turn, in order. */
  text: string;
  context: ContextReport | null;
}

interface OpenText {
  id: string;
  text: string;
}

interface ToolState {
  name: string;
  input: unknown;
  /** The last output snapshot; ACP replaces content wholesale, the app wants deltas. */
  text: string;
  title: string | null;
}

/** The tool name the app shows for an ACP tool kind. ACP names the kind of work, not always the tool. */
const toolNameFor: Record<ToolKind, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "shell",
  think: "task",
  fetch: "fetch",
  switch_mode: "mode",
  other: "tool",
};

const planMarks = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;

/**
 * Maps ACP session updates onto the app's events. One instance per session:
 * ACP streams chunks without start or end markers, so the mapper remembers
 * which message, thought and tool call are open and closes them itself.
 */
export class AcpUpdateMapper {
  private message: OpenText | null = null;
  private thought: OpenText | null = null;
  private readonly tools = new Map<string, ToolState>();
  private context: ContextReport | null = null;
  private turnText: string[] = [];

  constructor(private readonly runId: string) {}

  map(update: SessionUpdate, ts: number): AgentEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.messageChunk(update.messageId ?? null, update.content, ts);
      case "agent_thought_chunk":
        return this.thoughtChunk(update.messageId ?? null, update.content, ts);
      case "tool_call":
        return this.toolCall(update, ts);
      case "tool_call_update":
        return this.toolCallUpdate(update, ts);
      case "plan":
        return [this.planActivity("plan", update.entries, ts)];
      case "plan_update":
        if (update.plan.type === "markdown") return [{ type: "plan.updated", runId: this.runId, ts, documentId: update.plan.planId, text: update.plan.content }];
        return [update.plan.type === "items" ? this.planActivity(update.plan.planId, update.plan.entries, ts) : this.planText(update.plan.planId, update.plan.uri, ts)];
      case "plan_removed":
        return [{ type: "activity.updated", runId: this.runId, ts, activityId: `plan-${update.planId}`, label: "Plan", status: "success" }];
      case "compaction_update": {
        let status: "running" | "success" | "error" = "error";
        if (update.status === "in_progress") status = "running";
        else if (update.status === "completed") status = "success";
        const text =
          update.summary
            ?.map(contentText)
            .filter((part): part is string => part !== null)
            .join("") ||
          update.error ||
          undefined;
        return [{ type: "activity.updated", runId: this.runId, ts, activityId: `compaction-${update.compactionId}`, label: "Compacting context", status, ...(text ? { text } : {}) }];
      }
      case "compaction_summary_chunk": {
        const text = contentText(update.content);
        return text ? [{ type: "activity.delta", runId: this.runId, ts, activityId: `compaction-${update.compactionId}`, label: "Compacting context", text }] : [];
      }
      case "usage_update":
        this.context = { used: update.used, size: update.size, ...(update.cost ? { costUsd: update.cost.amount } : {}) };
        return [];
      default:
        // User echoes, command lists, mode and config changes carry nothing the transcript shows.
        return [];
    }
  }

  /** The turn ended: close what is still streaming and report what the turn produced. */
  endTurn(ts: number): TurnSummary {
    const events = [...this.closeMessage(ts), ...this.closeThought(ts)];
    const text = this.turnText.join("\n\n");
    const context = this.context;
    this.turnText = [];
    this.context = null;
    return { events, text, context };
  }

  /** A checklist plan: done once every entry is. */
  private planActivity(planId: string, entries: PlanEntry[], ts: number): AgentEvent {
    const text = entries.map((entry) => `${planMarks[entry.status]} ${entry.content}`).join("\n");
    const done = entries.length > 0 && entries.every((entry) => entry.status === "completed");
    return { type: "activity.updated", runId: this.runId, ts, activityId: `plan-${planId}`, label: "Plan", status: done ? "success" : "running", text };
  }

  /** A plan kept as prose or in a file; there is no per-entry state to finish. */
  private planText(planId: string, text: string, ts: number): AgentEvent {
    return { type: "activity.updated", runId: this.runId, ts, activityId: `plan-${planId}`, label: "Plan", status: "running", text };
  }

  private messageChunk(id: string | null, content: ContentBlock, ts: number): AgentEvent[] {
    const text = contentText(content);
    if (text === null) return [];
    const events: AgentEvent[] = [];
    const messageId = id ?? this.message?.id ?? `message-${ts}`;
    if (this.message && this.message.id !== messageId) events.push(...this.closeMessage(ts));
    if (!this.message) this.message = { id: messageId, text: "" };
    this.message.text += text;
    events.push({ type: "message.delta", runId: this.runId, ts, messageId, role: "assistant", text });
    return events;
  }

  private thoughtChunk(id: string | null, content: ContentBlock, ts: number): AgentEvent[] {
    const text = contentText(content);
    if (text === null) return [];
    const events: AgentEvent[] = [];
    const messageId = id ?? this.thought?.id ?? `thought-${ts}`;
    if (this.thought && this.thought.id !== messageId) events.push(...this.closeThought(ts));
    if (!this.thought) {
      this.thought = { id: messageId, text: "" };
      events.push({ type: "thinking.started", runId: this.runId, ts, messageId });
    }
    this.thought.text += text;
    events.push({ type: "thinking.delta", runId: this.runId, ts, messageId, text });
    return events;
  }

  private closeMessage(ts: number): AgentEvent[] {
    if (!this.message) return [];
    const { id, text } = this.message;
    this.message = null;
    this.turnText.push(text);
    return [{ type: "message.completed", runId: this.runId, ts, messageId: id, role: "assistant", text }];
  }

  private closeThought(ts: number): AgentEvent[] {
    if (!this.thought) return [];
    const { id, text } = this.thought;
    this.thought = null;
    return [{ type: "thinking.completed", runId: this.runId, ts, messageId: id, text }];
  }

  private toolCall(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>, ts: number): AgentEvent[] {
    const name = update.name ?? toolNameFor[update.kind ?? "other"];
    const input = update.rawInput ?? { title: update.title };
    this.tools.set(update.toolCallId, { name, input, text: "", title: update.title });
    const events: AgentEvent[] = [{ type: "tool.started", runId: this.runId, ts, toolCallId: update.toolCallId, name, input, parentToolCallId: null }];
    events.push(...this.fileChanges(update.content, ts));
    return events;
  }

  private toolCallUpdate(update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>, ts: number): AgentEvent[] {
    const events: AgentEvent[] = [];
    let tool = this.tools.get(update.toolCallId);
    if (!tool) {
      // An update for a call this session never announced, as after a resume: announce it now.
      tool = { name: update.name ?? toolNameFor[update.kind ?? "other"], input: update.rawInput ?? {}, text: "", title: update.title ?? null };
      this.tools.set(update.toolCallId, tool);
      events.push({ type: "tool.started", runId: this.runId, ts, toolCallId: update.toolCallId, name: tool.name, input: tool.input, parentToolCallId: null });
    }
    if (update.rawInput !== undefined && update.rawInput !== null) tool.input = update.rawInput;
    events.push(...this.fileChanges(update.content, ts));
    const text = toolText(update.content);
    switch (update.status) {
      case "completed":
      case "failed": {
        this.tools.delete(update.toolCallId);
        const failed = update.status === "failed";
        const output = update.rawOutput !== undefined && update.rawOutput !== null ? outputOf(update.rawOutput) : (text ?? null);
        events.push({
          type: "tool.completed",
          runId: this.runId,
          ts,
          toolCallId: update.toolCallId,
          name: tool.name,
          output,
          isError: failed,
          status: failed ? "error" : "success",
          input: tool.input,
        });
        return events;
      }
      default: {
        if (text !== null && text !== tool.text) {
          const delta = text.startsWith(tool.text) ? text.slice(tool.text.length) : text;
          tool.text = text;
          if (delta) events.push({ type: "tool.output.delta", runId: this.runId, ts, toolCallId: update.toolCallId, text: delta });
        } else if (update.title && update.title !== tool.title) {
          tool.title = update.title;
          events.push({ type: "tool.updated", runId: this.runId, ts, toolCallId: update.toolCallId, progress: update.title });
        }
        return events;
      }
    }
  }

  private fileChanges(content: ToolCallContent[] | null | undefined, ts: number): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const item of content ?? []) {
      if (item.type !== "diff" || !item.path) continue;
      events.push({ type: "file.changed", runId: this.runId, ts, path: item.path, kind: item.oldText ? "modify" : "add" });
    }
    return events;
  }
}

function contentText(block: ContentBlock): string | null {
  return block.type === "text" ? block.text : null;
}

/** The readable text of a tool call's content, or null when it carries none. */
function toolText(content: ToolCallContent[] | null | undefined): string | null {
  if (!content) return null;
  const parts = content.flatMap((item) => (item.type === "content" ? (contentText(item.content) ?? []) : []));
  return parts.length ? parts.join("") : null;
}

/** OpenCode wraps a tool's output as `{ output, metadata }`; the transcript wants the output itself. */
function outputOf(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record["output"] === "string") return record["output"];
    if (typeof record["error"] === "string") return record["error"];
  }
  return raw;
}
