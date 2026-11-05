import type { AgentEvent } from "@openorc/protocol";
import { sessionId } from "../session-slot.js";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Maps `opencode run --format json` lines onto AgentEvents. One process answers one prompt: its first line names the
 * session, its last step prints no finish, and the turn ends with the process, so `end` closes it.
 */
export class OpenCodeRunParser {
  private startedAt: number | null = null;
  private lastReply: string | null = null;
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
    const part = isRecord(event["part"]) ? event["part"] : {};
    return [...this.started(event, base), ...(this.read[String(event["type"])]?.(part, base, event) ?? [])];
  }

  /** The first line names the session, which opens the run and its one turn. */
  private started(event: Record<string, unknown>, base: { runId: string; ts: number }): AgentEvent[] {
    if (this.startedAt !== null || typeof event["sessionID"] !== "string") return [];
    this.startedAt = base.ts;
    return [
      { type: "session.started", ...base, agent: "opencode", externalSessionId: sessionId(event["sessionID"]), model: null },
      { type: "turn.started", ...base, turnId: "turn-1" },
    ];
  }

  /** The lines that carry something, by type; steps only frame them. */
  private readonly read: Record<string, (part: Record<string, unknown>, base: { runId: string; ts: number }, event: Record<string, unknown>) => AgentEvent[]> = {
    text: (part, base) => {
      const reply = text(part["text"]);
      if (reply === null) return [];
      this.lastReply = reply;
      return [{ type: "message.completed", ...base, messageId: text(part["id"]) ?? `message-${base.ts}`, role: "assistant", text: reply }];
    },
    tool_use: (part, base) => {
      const state = isRecord(part["state"]) ? part["state"] : {};
      const toolCallId = text(part["id"]) ?? text(part["partID"]) ?? `tool-${base.ts}`;
      const name = text(part["tool"]) ?? "tool";
      const failed = state["status"] === "error";
      return [
        { type: "tool.started", ...base, toolCallId, name, input: state["input"], parentToolCallId: null },
        { type: "tool.completed", ...base, toolCallId, name, input: state["input"], output: state["output"] ?? state["error"], isError: failed, status: failed ? "error" : "success" },
      ];
    },
    error: (_part, base, event) => {
      const error = isRecord(event["error"]) ? text(event["error"]["message"]) : null;
      return [{ type: "error", ...base, message: error ?? "OpenCode reported an error.", fatal: false }];
    },
  };

  end(code: number | null, now = Date.now()): AgentEvent[] {
    if (this.startedAt === null) return [];
    this.turns = 1;
    const status = code === 0 ? "success" : "error";
    return [{ type: "turn.completed", runId: this.runId, ts: now, turnId: "turn-1", status, ...(this.lastReply ? { resultText: this.lastReply } : {}), durationMs: now - this.startedAt }];
  }
}
