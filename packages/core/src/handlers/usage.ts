import { projectActivity, usageHistory, type Db, type LedgerWriter } from "@openorc/db";
import type { Handlers } from "./types.js";

export function createUsageHandlers({ db, ledger }: { db: Db; ledger: Pick<LedgerWriter, "flush"> }): Pick<Handlers, "usage.history" | "projects.activity"> {
  return {
    "usage.history": (params) => {
      ledger.flush();
      return usageHistory(db, params);
    },
    "projects.activity": (params) => {
      ledger.flush();
      return projectActivity(db, params);
    },
  };
}
