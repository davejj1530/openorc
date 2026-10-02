import type { Block } from "./transcript";
import { toolShowsCard } from "./task-progress";

/** Persisted turn identity wins; user messages and terminal events also cover older transcripts. */
export function workTurns(blocks: Block[]): { id: string; blocks: Block[] }[] {
  const turns: { id: string; blocks: Block[] }[] = [];
  let current: { id: string; blocks: Block[] } | undefined;
  for (const block of blocks) {
    const boundary = block.kind === "status" && (block.boundary || /^turn (finished|error|cancelled) in /.test(block.text));
    if (
      current &&
      ((block.turnKey && current.blocks[0]?.turnKey && block.turnKey !== current.blocks[0].turnKey) ||
        (block.kind === "message" && block.role === "user" && current.blocks.some((b) => b.kind !== "status")))
    )
      current = undefined;
    if (!current && block.kind === "status" && block.boundary === "session" && turns.length) {
      turns.at(-1)!.blocks.push(block);
      continue;
    }
    if (!current) {
      current = { id: `${block.turnKey ?? "turn"}/${block.id}`, blocks: [] };
      turns.push(current);
    }
    current.blocks.push(block);
    if (boundary) current = undefined;
  }
  return turns;
}

/** A person's message reads before the turn's work, and so does a notice that opens the turn, such as who started it. */
function readsFirst(block: Block, index: number): boolean {
  return block.kind === "message" && (block.role === "user" || (block.role === "system" && index === 0));
}

export function workParts(blocks: Block[], live: boolean, taskCards = true, ambient = false) {
  let finalStart = blocks.findLastIndex((b) => b.kind === "message" && b.role === "assistant");
  while (finalStart > 0) {
    const previous = blocks[finalStart - 1];
    if (previous?.kind !== "message" || previous.role !== "assistant") break;
    finalStart--;
  }
  // Show the trailing reply as it arrives, even when activity is hidden. If more work
  // follows, that text becomes intermediate commentary until the turn finishes.
  const showReply = !ambient && finalStart >= 0 && (!live || blocks.slice(finalStart).every((b) => b.kind === "message" || b.kind === "status"));
  const before: Block[] = [],
    work: Block[] = [],
    after: Block[] = [];
  for (const [index, b] of blocks.entries()) {
    if (readsFirst(b, index)) before.push(b);
    else if (
      (b.kind === "message" && (b.role === "system" || /^API Error:/.test(b.text) || (showReply && b.role === "assistant" && index >= finalStart))) ||
      (b.kind === "approval" && (!b.decision || b.decision === "deny" || b.approvalKind === "user_input")) ||
      // Failed attempts stay with their work history; turn outcomes and provider
      // errors carry the overall failure state without promoting earlier retries.
      (b.kind === "tool" && taskCards && toolShowsCard(b)) ||
      (b.kind === "activity" && b.activityKind === "image_generation") ||
      (b.kind === "status" && b.tone === "bad" && !/^(turn|session) /.test(b.text))
    )
      after.push(b);
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
