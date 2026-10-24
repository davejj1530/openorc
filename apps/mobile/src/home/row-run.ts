import type { RunTranscript } from "@openorc/client";
import { useEffect } from "react";
import { client } from "../client";
import { useRunRead } from "../run-read";
import { useHomeCovered } from "./home-cover";

/**
 * A thread's live run for its Home row, held loaded so its frames keep arriving. Home stays mounted under a thread,
 * and a row that re-rendered for every frame the open thread streams would cost that thread about a millisecond a
 * frame. So the row follows the run while Home is in view, under a sheet too; while a thread hides Home it still
 * shows the run, without re-rendering for its frames, and catches up once Home shows again.
 */
export function useRowRun(runId: string | undefined): RunTranscript | undefined {
  const shown = !useHomeCovered();
  useEffect(() => (runId ? client.runs.retain([runId]) : undefined), [runId]);
  return useRunRead(client.runs, (runs) => (runId ? runs.get(runId) : undefined), shown);
}
