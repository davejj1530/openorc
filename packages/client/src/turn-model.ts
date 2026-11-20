import { useEffect, useMemo, useState } from "react";
import type { Block } from "./transcript.js";
import { receiptItems, type TurnSize } from "./work-receipt.js";
import { isSignal, workEntries } from "./work-steps.js";
import { workDuration, workParts, workTiming } from "./work-transcript.js";

/** Where a turn stands, as its end says it: working with its clock, writing the reply, or done, failed or stopped. */
export type TurnStatus = { kind: "working" | "writing" | "done" | "failed" | "stopped" | "no_updates"; elapsed?: number | undefined };

/** The words for a status: "Working 12s", "Writing", "Failed after 3s", or "Worked for 1m 12s" once done. */
export function turnStatusWords({ kind, elapsed }: TurnStatus): string {
  const time = elapsed === undefined ? "" : workDuration(elapsed);
  if (kind === "working") return time ? `Working ${time}` : "Working";
  if (kind === "writing") return "Writing";
  if (kind === "failed") return time ? `Failed after ${time}` : "Failed";
  if (kind === "stopped") return time ? `Stopped after ${time}` : "Stopped";
  if (kind === "no_updates") return "No updates";
  return time ? `Worked for ${time}` : "";
}

/** A clock that ticks once a second while `active`, and stands still otherwise. */
export function useTicking(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function statusKind(live: boolean, writing: boolean, outcome: string | undefined): TurnStatus["kind"] {
  if (live) return writing ? "writing" : "working";
  if (outcome === "error") return "failed";
  if (outcome === "cancelled") return "stopped";
  if (outcome === "no_updates") return "no_updates";
  return "done";
}

/** Where a turn stands at `now`: a live turn counts from its start, a finished one reads how long it took. */
export function turnStatus(turn: { live: boolean; writing: boolean; outcome: string | undefined; startedAt: number | undefined; durationMs: number | undefined }, now: number): TurnStatus {
  const elapsed = turn.live && turn.startedAt !== undefined ? Math.max(0, now - turn.startedAt) : turn.durationMs;
  return { kind: statusKind(turn.live, turn.writing, turn.outcome), elapsed };
}

/** The reply a finished turn's Copy copies: the last assistant message with words among what follows its work. */
export function turnReply(after: Block[]): Extract<Block, { kind: "message" }> | undefined {
  return after.findLast((block): block is Extract<Block, { kind: "message" }> => block.kind === "message" && block.role === "assistant" && Boolean(block.text));
}

/**
 * What a turn shows around its blocks: its parts (the prompt, the work, the reply), the status its end reads, and the
 * receipt row that opens its work.
 */
export function useTurnModel(blocks: Block[], live: boolean, taskCards: boolean | undefined, ambient: boolean, pinned: string | undefined, size: TurnSize | null = null) {
  const timing = workTiming(blocks, live);
  const parts = useMemo(() => workParts(blocks, timing.live, taskCards, ambient), [blocks, timing.live, taskCards, ambient]);
  const steps = useMemo(() => {
    const entries = workEntries(
      parts.work.filter((block) => block.kind !== "tool" || !block.subagent),
      taskCards ?? true,
      pinned,
    );
    // While the turn runs, a wait that is over is not a step it took.
    return (timing.live ? entries.filter((entry) => entry.kind !== "blocks" || !entry.blocks.every(isSignal)) : entries).length;
  }, [parts.work, taskCards, pinned, timing.live]);
  const now = useTicking(timing.live);
  const writing = parts.after.some((block) => block.kind === "message" && block.role === "assistant" && block.streaming);
  const status = turnStatus({ ...timing, writing }, now);
  const receipt = useMemo(() => receiptItems(blocks, steps, timing.live, size), [blocks, steps, timing.live, size]);
  const reply = turnReply(parts.after);
  return { live: timing.live, parts, status, receipt, reply };
}
