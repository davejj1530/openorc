import { useEffect, useMemo, useState } from "react";
import type { Block } from "./transcript.js";
import { receiptItems } from "./work-receipt.js";
import { workEntries } from "./work-steps.js";
import { workDuration, workParts, workTiming } from "./work-transcript.js";

/** Where a turn stands, as its head says it: working with its clock, writing the reply, or done, failed or stopped. */
export type TurnStatus = { kind: "working" | "writing" | "done" | "failed" | "stopped"; elapsed?: number | undefined };

/** The head's words for a status: "working 12s", "Writing", "Failed after 3s", or how long a finished turn took. */
export function turnStatusWords({ kind, elapsed }: TurnStatus): string {
  const time = elapsed === undefined ? "" : workDuration(elapsed);
  if (kind === "working") return time ? `working ${time}` : "working";
  if (kind === "writing") return "Writing";
  if (kind === "failed") return time ? `Failed after ${time}` : "Failed";
  if (kind === "stopped") return time ? `Stopped after ${time}` : "Stopped";
  return time;
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
 * What a turn shows above and around its blocks: its parts (the prompt, the work, the reply), the status its head
 * reads, and the receipt row that opens its work.
 */
export function useTurnModel(blocks: Block[], live: boolean, taskCards: boolean | undefined, ambient: boolean, pinned: string | undefined) {
  const timing = workTiming(blocks, live);
  const parts = useMemo(() => workParts(blocks, timing.live, taskCards, ambient), [blocks, timing.live, taskCards, ambient]);
  const steps = useMemo(() => workEntries(parts.work, taskCards ?? true, pinned).length, [parts.work, taskCards, pinned]);
  const now = useTicking(timing.live);
  const writing = parts.after.some((block) => block.kind === "message" && block.role === "assistant" && block.streaming);
  const status = turnStatus({ ...timing, writing }, now);
  const receipt = useMemo(() => receiptItems(blocks, steps, timing.live), [blocks, steps, timing.live]);
  const reply = turnReply(parts.after);
  return { live: timing.live, parts, status, receipt, reply };
}
