import { completedToolCall, Db, LedgerWriter, listEvents, transcriptPage } from "@openorc/db";
import { FrameCoalescer } from "../frames.js";
import { RunService } from "../services/runs.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  frames: Pick<FrameCoalescer, "flush">;
  ledger: Pick<LedgerWriter, "flush">;
  db: Db;
  runService: Pick<RunService, "isLive">;
};

export function createEventsHandlers({ frames, ledger, db, runService }: Dependencies): Pick<Handlers, "events.listForRun" | "events.page" | "events.toolOutput"> {
  return {
    "events.listForRun": ({ runId, afterSeq, limit }) => {
      frames.flush();
      ledger.flush();
      return listEvents(db, runId, { ...(afterSeq !== undefined ? { afterSeq } : {}), limit: limit ?? -1 });
    },
    "events.page": ({ runId, fromTurn, turns }) => {
      frames.flush();
      ledger.flush();
      return { ...transcriptPage(db, runId, { fromTurn, turns }), live: runService.isLive(runId) };
    },
    "events.toolOutput": ({ runId, toolCallId }) => {
      ledger.flush();
      return { output: completedToolCall(db, runId, toolCallId)?.output ?? null };
    },
  };
}
