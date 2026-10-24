import type { RunStore, RunTranscript } from "@openorc/client";
import { useSyncExternalStore } from "react";

const still = () => () => undefined;

/**
 * Reads the run store as views were last told: `read` runs on every render, and the view re-renders for the store's
 * updates only while `follow`. A view that stops following keeps showing what it read, at no cost per frame.
 */
export function useRunRead<T>(runs: RunStore, read: (runs: ReadonlyMap<string, RunTranscript>) => T, follow: boolean): T {
  return useSyncExternalStore(follow ? runs.subscribe : still, () => read(runs.snapshot()));
}

/** A block of a run by id, as the store last published it. */
export function runBlock(runs: ReadonlyMap<string, RunTranscript>, runId: string, blockId: string) {
  const run = runs.get(runId);
  const at = run?.blockIndex.get(blockId);
  return at === undefined ? undefined : run?.blocks[at];
}
