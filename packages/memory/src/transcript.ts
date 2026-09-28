import type { AgentEvent } from "@openorc/protocol";

export interface RunDigest {
  prompts: string[];
  assistant: string[];
  toolLines: string[];
  filesTouched: string[];
}

/** The only event kinds digestRun reads. */
export const DIGEST_EVENT_KINDS = ["message.completed", "tool.started", "tool.completed", "file.changed"] as const satisfies readonly AgentEvent["type"][];

/**
 * Fold a run's raw events into the few things extraction cares about: what was
 * asked, what the agent concluded, which tools ran with what outcome, and which
 * files changed. Keeps the LLM input small and cheap.
 */
export function digestRun(events: AgentEvent[]): RunDigest {
  const prompts: string[] = [];
  const assistant: string[] = [];
  const toolLines: string[] = [];
  const files = new Set<string>();
  const toolNames = new Map<string, string>();

  for (const ev of events) {
    switch (ev.type) {
      case "message.completed":
        if (ev.role === "user") prompts.push(ev.text.trim());
        else if (ev.text.trim()) assistant.push(ev.text.trim());
        break;
      case "tool.started":
        toolNames.set(ev.toolCallId, ev.name);
        break;
      case "tool.completed": {
        const name = ev.name || toolNames.get(ev.toolCallId) || "tool";
        const out = typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output ?? "");
        toolLines.push(`${ev.isError ? "FAILED " : ""}${name}: ${out.replace(/\s+/g, " ").slice(0, 160)}`);
        break;
      }
      case "file.changed":
        files.add(`${ev.kind} ${ev.path}`);
        break;
      default:
        break;
    }
  }
  return { prompts, assistant, toolLines: toolLines.slice(-60), filesTouched: [...files].slice(0, 60) };
}

/** A compact plain-text rendering of the digest for the extraction prompt. */
export function renderDigest(d: RunDigest, maxChars = 12_000): string {
  const parts: string[] = [];
  if (d.prompts.length) parts.push("## User asked\n" + d.prompts.join("\n---\n"));
  if (d.filesTouched.length) parts.push("## Files changed\n" + d.filesTouched.join("\n"));
  if (d.toolLines.length) parts.push("## Tool activity\n" + d.toolLines.join("\n"));
  if (d.assistant.length) parts.push("## Agent said\n" + d.assistant.slice(-6).join("\n---\n"));
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}
