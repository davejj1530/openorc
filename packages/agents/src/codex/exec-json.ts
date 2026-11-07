import type { AgentEvent } from "@openorc/protocol";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function changeKind(value: unknown): "add" | "delete" | "rename" | "modify" {
  const name = typeof value === "string" ? value : "update";
  if (name.startsWith("add")) return "add";
  if (name.startsWith("del")) return "delete";
  if (name.startsWith("ren")) return "rename";
  return "modify";
}

/**
 * Maps `codex exec --json` lines onto AgentEvents, named as the app-server's items are: commands as `shell`, edits as
 * `apply_patch` with a file change per path. OpenAI publishes no schema for this stream and its names have moved
 * between versions, so lines and items it does not know are left out. One process answers one prompt.
 */
export class CodexExecParser {
  private turn = 0;
  private turnStartedAt = 0;
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
    switch (event["type"]) {
      case "thread.started":
        return [{ type: "session.started", ...base, agent: "codex", externalSessionId: text(event["thread_id"]), model: null }];
      case "turn.started":
        this.turn += 1;
        this.turnStartedAt = now;
        return [{ type: "turn.started", ...base, turnId: `turn-${this.turn}` }];
      case "turn.completed":
        this.turns += 1;
        return [{ type: "turn.completed", ...base, turnId: `turn-${this.turn}`, status: "success", ...(this.lastReply ? { resultText: this.lastReply } : {}), durationMs: now - this.turnStartedAt }];
      case "turn.failed": {
        const error = isRecord(event["error"]) ? text(event["error"]["message"]) : null;
        return [
          { type: "error", ...base, message: error ?? "Codex could not finish the turn.", fatal: false },
          { type: "turn.completed", ...base, turnId: `turn-${this.turn}`, status: "error", durationMs: now - this.turnStartedAt },
        ];
      }
      case "error":
        return [{ type: "error", ...base, message: text(event["message"]) ?? "Codex reported an error.", fatal: false }];
      case "item.started":
      case "item.completed":
        return isRecord(event["item"]) ? this.item(event["item"], event["type"] === "item.started", base) : [];
      default:
        return [];
    }
  }

  private item(item: Record<string, unknown>, started: boolean, base: { runId: string; ts: number }): AgentEvent[] {
    const id = text(item["id"]) ?? `item-${base.ts}`;
    switch (item["type"]) {
      case "agent_message":
      case "assistant_message": {
        const reply = text(item["text"]);
        if (started || reply === null) return [];
        this.lastReply = reply;
        return [{ type: "message.completed", ...base, messageId: id, role: "assistant", text: reply }];
      }
      case "command_execution": {
        const input = { command: item["command"] };
        if (started) return [{ type: "tool.started", ...base, toolCallId: id, name: "shell", input, parentToolCallId: null }];
        const failed = item["status"] === "failed" || (typeof item["exit_code"] === "number" && item["exit_code"] !== 0);
        return [{ type: "tool.completed", ...base, toolCallId: id, name: "shell", input, output: item["aggregated_output"], isError: failed, status: failed ? "error" : "success" }];
      }
      case "file_change": {
        const changes = Array.isArray(item["changes"]) ? item["changes"].filter(isRecord) : [];
        if (started) return [{ type: "tool.started", ...base, toolCallId: id, name: "apply_patch", input: changes, parentToolCallId: null }];
        const failed = item["status"] === "failed";
        return [
          { type: "tool.completed", ...base, toolCallId: id, name: "apply_patch", input: changes, output: undefined, isError: failed, status: failed ? "error" : "success" },
          ...changes.flatMap((change): AgentEvent[] => (typeof change["path"] === "string" ? [{ type: "file.changed", ...base, path: change["path"], kind: changeKind(change["kind"]) }] : [])),
        ];
      }
      default:
        return [];
    }
  }
}
