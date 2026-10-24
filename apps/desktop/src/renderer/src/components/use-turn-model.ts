import { useEffect, useMemo, useState } from "react";
import { type Block, workParts, workTiming, receiptItems, workEntries } from "@openorc/client";
import type { TurnStatus } from "./TurnHead";

/** A clock that ticks once a second while `active`, and stands still otherwise. */
function useTicking(active: boolean): number {
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

/**
 * What a turn shows above and around its blocks: its parts (the prompt, the work, the reply), the status its head
 * reads, and the receipt row that opens its work.
 */
export function useTurnModel(blocks: Block[], live: boolean, taskCards: boolean | undefined, ambient: boolean, pinned: string | undefined) {
  const timing = workTiming(blocks, live);
  const parts = useMemo(() => workParts(blocks, timing.live, taskCards, ambient), [blocks, timing.live, taskCards, ambient]);
  const steps = useMemo(() => workEntries(parts.work, taskCards ?? true, pinned).length, [parts.work, taskCards, pinned]);
  const now = useTicking(timing.live);
  const elapsed = timing.live && timing.startedAt !== undefined ? Math.max(0, now - timing.startedAt) : timing.durationMs;
  const writing = parts.after.some((block) => block.kind === "message" && block.role === "assistant" && block.streaming);
  const status: TurnStatus = { kind: statusKind(timing.live, writing, timing.outcome), elapsed };
  const receipt = useMemo(() => receiptItems(blocks, steps, timing.live), [blocks, steps, timing.live]);
  const reply = parts.after.findLast((block): block is Extract<Block, { kind: "message" }> => block.kind === "message" && block.role === "assistant" && Boolean(block.text));
  return { live: timing.live, parts, status, receipt, reply };
}
