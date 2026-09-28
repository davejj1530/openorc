import type { Usage } from "@openorc/protocol";
import type { Db } from "./database.js";

export const runCosts = {
  /**
   * The running cost an earlier run last reported for this provider session. Providers report what a session has
   * cost so far, and a resumed session continues its old total, so a new run subtracts this before counting anything.
   */
  previousSessionCost(db: Db, externalSessionId: string, runId: string): number {
    const row = db.stmt("SELECT usage FROM runs WHERE external_session_id = ? AND id != ? AND usage IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(externalSessionId, runId) as
      { usage: string } | undefined;
    return row ? ((JSON.parse(row.usage) as Usage).costUsd ?? 0) : 0;
  },
};
