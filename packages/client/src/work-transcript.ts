import type { Block } from "./transcript.js";
import { toolShowsCard } from "./task-progress.js";
import { visualizationFromTool } from "./visualization.js";
import { isSubagentBlock } from "./transcript-subagents.js";

/** A status line that closes its turn: a turn or session boundary, or the outcome line older transcripts carry. */
function endsTurn(block: Block): boolean {
  return block.kind === "status" && Boolean(block.boundary || /^turn (finished|error|cancelled) in /.test(block.text));
}

type WorkTurn = { id: string; blocks: Block[] };

/** Anything but a person's message or a status line: what the agent did in its turn, and notices about it. */
function fromAgent(block: Block): boolean {
  return block.kind !== "status" && !(block.kind === "message" && block.role === "user");
}

/**
 * Where a block opens a new turn: "turn" when its persisted turn differs, "steer" when a person speaks after the agent
 * did something, so what the agent does next reads below the message.
 */
function startsTurn(current: WorkTurn, block: Block): "turn" | "steer" | null {
  const key = current.blocks[0]?.turnKey;
  if (block.turnKey && key && block.turnKey !== key) return "turn";
  return block.kind === "message" && block.role === "user" && current.blocks.some(fromAgent) ? "steer" : null;
}

/**
 * Persisted turn identity wins; user messages and terminal events also cover older transcripts. A steer reads where it
 * was sent while the turn runs. If the turn ends before the agent answers it, it joins the part it steered, whose head
 * then carries the turn's outcome instead of a head of its own over nothing.
 */
export function workTurns(blocks: Block[]): WorkTurn[] {
  const turns: WorkTurn[] = [];
  let current: WorkTurn | undefined;
  let steered: WorkTurn | undefined;
  for (const block of blocks) {
    const starts = current && startsTurn(current, block);
    if (starts) {
      steered = starts === "steer" ? current : undefined;
      current = undefined;
    }
    if (!current && block.kind === "status" && block.boundary === "session" && turns.length) {
      turns.at(-1)!.blocks.push(block);
      continue;
    }
    if (!current) {
      current = { id: `${block.turnKey ?? "turn"}/${block.id}`, blocks: [] };
      turns.push(current);
    }
    current.blocks.push(block);
    if (!endsTurn(block)) continue;
    if (steered && !current.blocks.some(fromAgent)) {
      steered.blocks.push(...current.blocks);
      turns.pop();
    }
    current = undefined;
    steered = undefined;
  }
  return turns;
}

/**
 * A person's message reads before the turn's work, and so do the notices that open the turn, such as who started it,
 * or the lines people's actions leave outside any turn: every one before the agent does anything.
 */
function readsFirst(block: Block, opening: boolean): boolean {
  return block.kind === "message" && (block.role === "user" || (block.role === "system" && opening && !block.inTurn));
}

/** A person's message or a notice said before the turn ran: what can open a turn before the agent does anything. */
const opens = (block: Block): boolean => block.kind === "message" && (block.role === "user" || (block.role === "system" && !block.inTurn));

/** Where the turn's closing reply starts: the run of assistant messages its last one ends. -1 without a reply. */
function replyStart(blocks: Block[]): number {
  let start = blocks.findLastIndex((b) => b.kind === "message" && b.role === "assistant");
  while (start > 0) {
    const previous = blocks[start - 1];
    if (previous?.kind !== "message" || previous.role !== "assistant") break;
    start--;
  }
  return start;
}

function statusAfterWork(block: Extract<Block, { kind: "status" }>): boolean {
  return Boolean(block.notice) || (block.tone === "bad" && !/^(turn|session) /.test(block.text));
}

/** Blocks shown after the turn's work instead of inside it. */
function showsAfterWork(b: Block, inReply: boolean, taskCards: boolean): boolean {
  switch (b.kind) {
    case "message":
      return b.role === "system" || /^API Error:/.test(b.text) || (inReply && b.role === "assistant");
    case "approval":
      return !b.decision || b.decision === "deny" || b.approvalKind === "user_input";
    // Failed attempts stay with their work history; turn outcomes and provider
    // errors carry the overall failure state without promoting earlier retries.
    case "tool":
      return (taskCards && toolShowsCard(b)) || visualizationFromTool(b) !== null;
    case "activity":
      return b.activityKind === "image_generation";
    case "status":
      return statusAfterWork(b);
    case "thinking":
      return false;
  }
}

export function workParts(blocks: Block[], live: boolean, taskCards = true, ambient = false) {
  const finalStart = replyStart(blocks);
  // Show the trailing reply as it arrives, even when activity is hidden. If more work
  // follows, that text becomes intermediate commentary until the turn finishes.
  const showReply = !ambient && finalStart >= 0 && (!live || blocks.slice(finalStart).every((b) => b.kind === "message" || b.kind === "status"));
  const before: Block[] = [],
    work: Block[] = [],
    after: Block[] = [];
  let opening = true;
  for (const [index, b] of blocks.entries()) {
    opening &&= opens(b);
    if (isSubagentBlock(b) && taskCards) {
      after.push(b);
      continue;
    }
    if (readsFirst(b, opening)) before.push(b);
    else if (showsAfterWork(b, showReply && index >= finalStart, taskCards)) after.push(b);
    else if (b.kind !== "status" && !(b.kind === "approval" && b.decision)) work.push(b);
  }
  if (ambient && !work.some((b) => b.kind === "tool" || b.kind === "activity")) work.length = 0;
  return { before, work, after };
}

export function workTiming(blocks: Block[], live: boolean) {
  const end =
    blocks.findLast((b): b is Extract<Block, { kind: "status" }> => b.kind === "status" && b.boundary === "turn") ??
    blocks.findLast((b): b is Extract<Block, { kind: "status" }> => b.kind === "status" && b.boundary === "session");
  const first = blocks.find((b) => b.at !== undefined || b.kind === "thinking");
  const startedAt = first?.at ?? (first?.kind === "thinking" ? first.startedAt : undefined);
  return { live: live && !end, startedAt, durationMs: end?.durationMs, outcome: end?.outcome };
}

export function workDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
