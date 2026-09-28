import type { Block } from "./transcript";
import type { RunState } from "@openorc/protocol";

/** An unanswered approval outranks a failed run; otherwise the task keeps its saved status. */
export function taskCardStatusLabel({ approvalKind, runState, taskLabel }: { approvalKind?: string; runState?: RunState; taskLabel: string }): string {
  if (approvalKind) return approvalKind === "user_input" ? "Needs your answer" : "Waiting for permission";
  if (runState === "error") return "Run failed";
  if (runState === "cancelled") return "Stopped";
  return taskLabel;
}

export function taskIdFromTool(block: Extract<Block, { kind: "tool" }>): string | null {
  if (!/task_(create|start)$/.test(block.name) || !block.done || block.isError) return null;
  const out = block.output;
  const content = Array.isArray(out) ? out : (out as { content?: unknown[] })?.content;
  let text: string;
  if (typeof out === "string") text = out;
  else if (content) text = content.map((c) => (c as { text?: string }).text ?? "").join("");
  else text = JSON.stringify(out ?? "");
  return /"id":\s*"([0-9a-f-]{36})"/.exec(text)?.[1] ?? null;
}

/** Create and start results share one live card; keep its first position as more results arrive. */
export function uniqueTaskCards(blocks: Block[], taskCards: boolean): Block[] {
  if (!taskCards) return blocks;
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const taskId = block.kind === "tool" ? taskIdFromTool(block) : null;
    if (!taskId) return true;
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    return true;
  });
}

export function taskActivity(blocks: Block[]) {
  const messages = blocks.filter((b): b is Extract<Block, { kind: "message" }> => b.kind === "message" && b.role === "assistant" && Boolean(b.text.trim()));
  const approvals = blocks.filter((b): b is Extract<Block, { kind: "approval" }> => b.kind === "approval" && !b.decision);
  const steps = blocks.filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool").slice(-3);
  return { message: messages.at(-1) ?? null, approval: approvals.at(-1) ?? null, steps };
}

export function taskStepLabel(name: string): string {
  const n = name.replace(/^mcp__.*?__|^openorc\./, "");
  if (n === "task_context") return "Reading project context";
  if (n === "memory_search") return "Searching project memory";
  if (n === "memory_record") return "Saving project memory";
  if (/shell|exec_command|Bash|run_command/.test(n)) return "Running a command";
  if (/apply_patch|Edit|Write/.test(n)) return "Editing files";
  if (/Read|read_file/.test(n)) return "Reading files";
  return n.replace(/_/g, " ");
}
