import { Db, orclings } from "@openorc/db";
import { LedgerUpkeep } from "../services/ledger-upkeep.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  threadService: Pick<ThreadService, "delete" | "fork" | "moveWorkspace" | "movePreview" | "restore" | "restorePreview">;
  upkeep: Pick<LedgerUpkeep, "forgetDeletedRuns">;
};
export function createThreadWorkspaceHandlers({
  db,
  threadService,
  upkeep,
}: Dependencies): Pick<Handlers, "threads.delete" | "threads.fork" | "threads.moveWorkspace" | "threads.movePreview" | "threads.restore" | "threads.restorePreview"> {
  return {
    "threads.delete": async ({ id }) => {
      const owner = orclings.forThread(db, id);
      if (owner) throw new Error(`This is ${owner.name}'s own conversation. Delete ${owner.name} to remove it.`);
      await threadService.delete(id);
      await upkeep.forgetDeletedRuns();
      return null;
    },
    "threads.fork": ({ id }) => threadService.fork(id),
    "threads.moveWorkspace": ({ id, to }) => threadService.moveWorkspace(id, to),
    "threads.movePreview": ({ id, to }) => threadService.movePreview(id, to),
    "threads.restore": async ({ id, checkpointId }) => {
      await threadService.restore(id, checkpointId);
      return null;
    },
    "threads.restorePreview": ({ id, checkpointId }) => threadService.restorePreview(id, checkpointId),
  };
}
