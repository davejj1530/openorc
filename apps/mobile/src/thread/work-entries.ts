import { reasoningSections, type RunTranscript, type WorkEntry, type WorkPhase } from "@openorc/client";
import { runBlock } from "../run-read";

/**
 * A turn's entries with each phase kept as last time's object when it still covers the same blocks, so a phase that
 * finished holds still while the live one grows. A phase is made from its blocks alone. `previous` holds the last
 * pass's phases by id, and is left holding this pass's.
 */
export function keepPhases(entries: WorkEntry[], previous: Map<string, WorkPhase>): WorkEntry[] {
  const kept = entries.map((entry) => {
    if (entry.kind !== "phase") return entry;
    const old = previous.get(entry.phase.id);
    const same = old && old.title === entry.phase.title && old.blocks.length === entry.phase.blocks.length && old.blocks.every((block, i) => block === entry.phase.blocks[i]);
    return same ? { ...entry, phase: old } : entry;
  });
  previous.clear();
  for (const entry of kept) if (entry.kind === "phase") previous.set(entry.phase.id, entry.phase);
  return kept;
}

/**
 * A reasoning phase's words as the run has them now. While reasoning streams under the same titles its row keeps the
 * block it was made from, so the live phase reads the words that came since from the run.
 */
export function phaseDetail(runs: ReadonlyMap<string, RunTranscript>, runId: string, phase: WorkPhase): string {
  const block = phase.source?.kind === "thinking" ? runBlock(runs, runId, phase.source.id) : undefined;
  return block?.kind === "thinking" ? (reasoningSections(block.text).at(-1)?.body ?? phase.detail) : phase.detail;
}
