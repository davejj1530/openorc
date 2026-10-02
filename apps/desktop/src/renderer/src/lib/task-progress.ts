import type { Block } from "./transcript";
import type { RunState } from "@openorc/protocol";

/** An unanswered approval outranks a failed run; otherwise the task keeps its saved status. */
export function taskCardStatusLabel({ approvalKind, runState, taskLabel }: { approvalKind?: string; runState?: RunState; taskLabel: string }): string {
  if (approvalKind) return approvalKind === "user_input" ? "Needs your answer" : "Waiting for permission";
  if (runState === "error") return "Run failed";
  if (runState === "cancelled") return "Stopped";
  return taskLabel;
}

type ToolBlock = Extract<Block, { kind: "tool" }>;

function toolText(block: ToolBlock): string {
  const out = block.output;
  const content = Array.isArray(out) ? out : (out as { content?: unknown[] })?.content;
  if (typeof out === "string") return out;
  if (content) return content.map((c) => (c as { text?: string }).text ?? "").join("");
  return JSON.stringify(out ?? "");
}

export function taskIdFromTool(block: ToolBlock): string | null {
  if (/thread_start$/.test(block.name)) return startedWorkFromTool(block)?.taskId ?? null;
  if (!/task_(create|start)$/.test(block.name) || !block.done || block.isError) return null;
  return /"id":\s*"([0-9a-f-]{36})"/.exec(toolText(block))?.[1] ?? null;
}

/** Whether a tool call shows as a live card rather than a step: a task it saved or started, or a thread it started. */
export function toolShowsCard(block: ToolBlock): boolean {
  return Boolean(taskIdFromTool(block) ?? startedWorkFromTool(block));
}

/** The thread an agent started elsewhere with a thread_start tool, and the saved task it took up, if any. */
export function startedWorkFromTool(block: ToolBlock): { threadId: string; taskId: string | null } | null {
  if (!/thread_start$/.test(block.name) || !block.done || block.isError) return null;
  try {
    const started = JSON.parse(toolText(block)) as { thread?: { id?: unknown }; task?: { id?: unknown } };
    if (typeof started.thread?.id !== "string") return null;
    return { threadId: started.thread.id, taskId: typeof started.task?.id === "string" ? started.task.id : null };
  } catch {
    return null;
  }
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
