import { z } from "zod";
import type { AgentEvent, Usage } from "@openorc/protocol";
import type { PiEvent } from "./rpc.js";

const block = z.object({ type: z.string(), text: z.string().optional(), thinking: z.string().optional() });
const messageEvent = z.object({ message: z.object({ role: z.string(), content: z.union([z.string(), z.array(block)]), stopReason: z.string().optional(), errorMessage: z.string().optional() }) });
const deltaEvent = z.object({ assistantMessageEvent: z.object({ type: z.string(), contentIndex: z.number(), delta: z.string().optional(), content: z.string().optional() }) });
const toolEvent = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown().optional(),
  parentToolCallId: z.string().optional(),
  result: z.unknown().optional(),
  partialResult: z.unknown().optional(),
  isError: z.boolean().optional(),
});
const result = z.object({ content: z.array(block) });
const textOf = (value: unknown): string | null => {
  const parsed = result.safeParse(value);
  return parsed.success ? parsed.data.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n") : null;
};

/** Only a session-level settled event ends an OpenOrc turn; retries and individual tool turns do not. */
export class PiEvents {
  private nextMessage = 0;
  private messageId = "";
  private readonly thoughts = new Map<number, string>();
  private readonly toolOutputs = new Map<string, string>();
  private messages: string[] = [];
  error: string | null = null;
  aborted = false;
  compacting = false;

  constructor(private readonly runId: string) {}

  begin(): void {
    this.messages = [];
    this.error = null;
    this.aborted = false;
  }

  get text(): string {
    return this.messages.join("\n\n");
  }

  map(event: PiEvent): AgentEvent[] {
    switch (event.type) {
      case "message_start":
        if (messageEvent.parse(event).message.role === "assistant") {
          this.messageId = `${this.runId}-pi-${++this.nextMessage}`;
          this.thoughts.clear();
        }
        return [];
      case "message_update":
        return this.messageUpdate(event);
      case "message_end":
        return this.messageEnd(event);
      case "tool_execution_start":
        return this.toolStart(event);
      case "tool_execution_update":
        return this.toolUpdate(event);
      case "tool_execution_end":
        return this.toolEnd(event);
      case "compaction_start":
        this.compacting = true;
        return [{ ...this.base(), type: "activity.updated", activityId: "pi-compaction", label: "Compacting context", status: "running" }];
      case "compaction_end":
        return this.compactionEnd(event);
      default:
        return [];
    }
  }

  private base() {
    return { runId: this.runId, ts: Date.now() };
  }

  private messageUpdate(event: PiEvent): AgentEvent[] {
    const parsed = deltaEvent.safeParse(event);
    if (!parsed.success) return [];
    const change = parsed.data.assistantMessageEvent;
    const base = this.base();
    if (change.type === "text_delta" && change.delta) return [{ ...base, type: "message.delta", messageId: this.messageId, role: "assistant", text: change.delta }];
    const messageId = `${this.messageId}-thinking-${change.contentIndex}`;
    if (change.type === "thinking_start") {
      this.thoughts.set(change.contentIndex, "");
      return [{ ...base, type: "thinking.started", messageId }];
    }
    if (change.type === "thinking_delta" && change.delta) {
      this.thoughts.set(change.contentIndex, (this.thoughts.get(change.contentIndex) ?? "") + change.delta);
      return [{ ...base, type: "thinking.delta", messageId, text: change.delta }];
    }
    if (change.type === "thinking_end") {
      const text = change.content ?? this.thoughts.get(change.contentIndex) ?? "";
      this.thoughts.delete(change.contentIndex);
      return [{ ...base, type: "thinking.completed", messageId, text }];
    }
    return [];
  }

  private messageEnd(event: PiEvent): AgentEvent[] {
    const { message } = messageEvent.parse(event);
    if (message.role !== "assistant") return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n\n");
    this.error = null;
    if (message.stopReason === "error") this.error = message.errorMessage || "Pi could not complete the response.";
    if (message.stopReason === "length") this.error = "Pi reached the model's output limit.";
    this.aborted = message.stopReason === "aborted";
    if (text) this.messages.push(text);
    const base = this.base();
    const thoughts: AgentEvent[] = [...this.thoughts].map(([index, text]) => ({ ...base, type: "thinking.completed", messageId: `${this.messageId}-thinking-${index}`, text }));
    this.thoughts.clear();
    return [...thoughts, { ...base, type: "message.completed", messageId: this.messageId, role: "assistant", text }];
  }

  private toolStart(event: PiEvent): AgentEvent[] {
    const tool = toolEvent.parse(event);
    return [{ ...this.base(), type: "tool.started", toolCallId: tool.toolCallId, name: tool.toolName, input: tool.args, parentToolCallId: tool.parentToolCallId ?? null }];
  }

  private toolUpdate(event: PiEvent): AgentEvent[] {
    const tool = toolEvent.parse(event);
    const text = textOf(tool.partialResult);
    if (!text) return [];
    const previous = this.toolOutputs.get(tool.toolCallId) ?? "";
    this.toolOutputs.set(tool.toolCallId, text);
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    return delta ? [{ ...this.base(), type: "tool.output.delta", toolCallId: tool.toolCallId, text: delta }] : [];
  }

  private toolEnd(event: PiEvent): AgentEvent[] {
    const tool = toolEvent.parse(event);
    this.toolOutputs.delete(tool.toolCallId);
    return [{ ...this.base(), type: "tool.completed", toolCallId: tool.toolCallId, name: tool.toolName, output: textOf(tool.result) ?? tool.result, isError: tool.isError ?? false }];
  }

  private compactionEnd(event: PiEvent): AgentEvent[] {
    this.compacting = false;
    const data = z.object({ aborted: z.boolean().optional(), errorMessage: z.string().optional() }).parse(event);
    let status: "cancelled" | "error" | "success" = data.errorMessage ? "error" : "success";
    if (data.aborted) status = "cancelled";
    return [
      {
        ...this.base(),
        type: "activity.updated",
        activityId: "pi-compaction",
        label: "Compacting context",
        status,
        ...(data.errorMessage ? { text: data.errorMessage } : {}),
      },
    ];
  }
}

export function piUsage(value: unknown): Usage {
  const stats = z
    .object({
      tokens: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
      cost: z.number(),
      contextUsage: z.object({ tokens: z.number().nullable(), contextWindow: z.number() }).optional(),
    })
    .parse(value);
  return {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    costUsd: stats.cost,
    ...(stats.contextUsage?.tokens != null ? { contextTokens: stats.contextUsage.tokens, contextWindow: stats.contextUsage.contextWindow } : {}),
  };
}
