import type { AgentEvent, SubagentStatus } from "@openorc/protocol";
import type { Block, RunTranscript } from "./transcript.js";

export interface SubagentCard {
  nativeId: string;
  toolCallId?: string;
  threadId: string;
  title: string;
  agentType?: string;
  group?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  progress?: string;
  result?: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
}

type ToolBlock = Extract<Block, { kind: "tool" }>;
type Lifecycle = Extract<AgentEvent, { type: "subagent.started" | "subagent.updated" }>;
const toolStatus: Record<SubagentStatus, ToolBlock["status"]> = { running: "running", completed: "success", failed: "error", stopped: "cancelled", no_updates: "disconnected" };

export function isSubagentBlock(block: Block): block is ToolBlock & { subagent: SubagentCard } {
  return block.kind === "tool" && Boolean(block.subagent);
}

export function subagentBlock(run: RunTranscript, event: Lifecycle): ToolBlock | null {
  if (!event.threadId) return null;
  const previous = run.blocks.find((block): block is ToolBlock => block.kind === "tool" && block.subagent?.nativeId === event.subagentId);
  const raw =
    event.type === "subagent.started" && event.toolCallId ? run.blocks.find((block): block is ToolBlock => block.kind === "tool" && block.id === event.toolCallId && !block.subagent) : undefined;
  const card: SubagentCard = previous?.subagent ?? { nativeId: event.subagentId, threadId: event.threadId, title: "Subagent", status: "running", startedAt: event.ts, endedAt: null };
  const next = updateCard(card, event);
  const id = previous?.id ?? raw?.id ?? (next.toolCallId && !run.blockIndex.has(next.toolCallId) ? next.toolCallId : `subagent-${event.subagentId}`);
  return {
    ...raw,
    ...previous,
    id,
    kind: "tool",
    name: "Agent",
    input: { description: next.title, prompt: next.prompt, subagent_type: next.agentType },
    subagent: next,
    done: next.status !== "running",
    isError: next.status === "failed",
    status: toolStatus[next.status],
  };
}

function updateCard(card: SubagentCard, event: Lifecycle): SubagentCard {
  let next: SubagentCard;
  if (event.type === "subagent.started") {
    next = {
      ...card,
      title: event.title,
      ...defined({ toolCallId: event.toolCallId, agentType: event.agentType, group: event.group, model: event.model, effort: event.effort, prompt: event.prompt }),
    };
  } else {
    const status = event.status ?? card.status;
    const reopened = status === "running" && card.status !== "running";
    next = {
      ...card,
      ...(reopened ? { result: undefined, progress: undefined, startedAt: event.ts } : {}),
      status,
      endedAt: status === "running" ? null : (card.endedAt ?? event.ts),
      ...defined({ progress: event.progress, result: event.result ?? event.error }),
    };
    if (status === "stopped") next.result = undefined;
  }
  return next;
}

function defined(fields: Record<string, string | undefined>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) values[key] = value;
  return values;
}

/** Cards from the same parent turn and workflow phase share a surface. */
export function subagentGroups(blocks: readonly Block[]): Map<string, ToolBlock[]> {
  const turns = new Map<string, ToolBlock[]>();
  for (const block of blocks) {
    if (block.kind !== "tool" || !block.subagent) continue;
    const key = JSON.stringify([block.turnKey ?? block.runId ?? "turn", block.subagent.group]);
    const group = turns.get(key) ?? [];
    group.push(block);
    turns.set(key, group);
  }
  return new Map([...turns.values()].map((group) => [group[0]!.id, group]));
}

export const subagentStatusLabel: Record<SubagentStatus, string> = { running: "Working", completed: "Done", stopped: "Stopped", failed: "Failed", no_updates: "No updates" };

/** Some Claude children return their answer only on the task's completion, including in already saved runs. */
export function subagentCompletionReply(run: RunTranscript, event: Extract<AgentEvent, { type: "turn.completed" }>): Block | null {
  if (!event.turnId.startsWith("subagent:")) return null;
  run.subagentCompletion = { turn: run.turnsCompleted, boundaryId: `turn-${event.turnId}:${run.turnsCompleted}` };
  const text = event.resultText?.trim();
  if (!text || event.status !== "success") return null;
  const replies = run.blocks.flatMap((block) => (block.kind === "message" && block.role === "assistant" && run.turnOf.get(block.id) === run.turnsCompleted ? [block.text] : []));
  if (replies.some((reply) => reply.trim() === text) || replies.join("\n\n").trim() === text) return null;
  const id = `subagent-result:${event.turnId}:${run.turnsCompleted}`;
  run.subagentCompletion.resultId = id;
  return { id, kind: "message", role: "assistant", text, streaming: false, at: event.ts };
}

/** A transcript file can deliver the real reply just after its completion notification. */
export function replaceSubagentCompletionReply(run: RunTranscript): void {
  const id = run.subagentCompletion?.resultId;
  if (!id) return;
  run.blocks = run.blocks.filter((block) => block.id !== id);
  run.blockIndex = new Map(run.blocks.map((block, index) => [block.id, index]));
  run.turnOf.delete(id);
  const { turn, boundaryId } = run.subagentCompletion!;
  run.subagentCompletion = { turn, boundaryId };
}
