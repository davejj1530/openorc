import type { AgentEvent } from "@openorc/protocol";
import { sessionId } from "../session-slot.js";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The text of a message or tool result: a string, or its text blocks joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block["type"] === "text")
    .map((block) => text(block["text"]) ?? "")
    .join("");
}

/**
 * Maps `omp -p --mode json` lines onto AgentEvents. One process answers one prompt: its first line is the session's
 * header, assistant messages arrive whole at `message_end`, and the run settles at `agent_settled`; the process's exit
 * closes the turn either way.
 */
export class OmpJsonParser {
  private startedAt: number | null = null;
  private lastReply: string | null = null;
  private failed = false;
  private messages = 0;
  /** Turns completed; read when the process exits. */
  turns = 0;

  constructor(private readonly runId: string) {}

  parseLine(line: string, now = Date.now()): AgentEvent[] {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isRecord(event)) return [];
    const base = { runId: this.runId, ts: now };
    return this.read[String(event["type"])]?.(event, base) ?? [];
  }

  /** The lines that carry something, by type; the rest only frame them or stream what `message_end` repeats whole. */
  private readonly read: Record<string, (event: Record<string, unknown>, base: { runId: string; ts: number }) => AgentEvent[]> = {
    session: (event, base) => {
      if (this.startedAt !== null) return [];
      this.startedAt = base.ts;
      return [
        { type: "session.started", ...base, agent: "omp", externalSessionId: sessionId(event["id"]), model: null },
        { type: "turn.started", ...base, turnId: "turn-1" },
      ];
    },
    message_end: (event, base) => {
      const message = isRecord(event["message"]) ? event["message"] : {};
      if (message["role"] !== "assistant") return [];
      const error = text(message["errorMessage"]);
      if (message["stopReason"] === "error" && error) {
        this.failed = true;
        return [{ type: "error", ...base, message: error, fatal: false }];
      }
      const reply = contentText(message["content"]);
      if (!reply) return [];
      this.lastReply = reply;
      return [{ type: "message.completed", ...base, messageId: `message-${++this.messages}`, role: "assistant", text: reply }];
    },
    tool_execution_start: (event, base) => [
      { type: "tool.started", ...base, toolCallId: text(event["toolCallId"]) ?? `tool-${base.ts}`, name: text(event["toolName"]) ?? "tool", input: event["args"], parentToolCallId: null },
    ],
    tool_execution_end: (event, base) => {
      const result = isRecord(event["result"]) ? event["result"] : {};
      const isError = event["isError"] === true;
      const toolCallId = text(event["toolCallId"]) ?? `tool-${base.ts}`;
      return [
        {
          type: "tool.completed",
          ...base,
          toolCallId,
          name: text(event["toolName"]) ?? "tool",
          input: event["args"],
          output: contentText(result["content"]),
          isError,
          status: isError ? "error" : "success",
        },
      ];
    },
  };

  end(code: number | null, now = Date.now()): AgentEvent[] {
    if (this.startedAt === null) return [];
    this.turns = 1;
    const status = code === 0 && !this.failed ? "success" : "error";
    return [{ type: "turn.completed", runId: this.runId, ts: now, turnId: "turn-1", status, ...(this.lastReply ? { resultText: this.lastReply } : {}), durationMs: now - this.startedAt }];
  }
}
