import { Db, orclings } from "@openorc/db";
import { NOT_FROM_PHONE } from "../remote/policy.js";
import { requestOrigin } from "../request-origin.js";
import { LedgerUpkeep } from "../services/ledger-upkeep.js";
import type { TeamTaskHere } from "../services/team-task-here.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  threadService: Pick<ThreadService, "delete" | "fork" | "moveWorkspace" | "movePreview" | "restore" | "restorePreview">;
  upkeep: Pick<LedgerUpkeep, "runsDeleted">;
  /** A team task's own thread, whose deletion the server hears of. */
  teamTasks: Pick<TeamTaskHere, "releasing">;
};
export function createThreadWorkspaceHandlers({
  db,
  threadService,
  upkeep,
  teamTasks,
}: Dependencies): Pick<Handlers, "threads.delete" | "threads.fork" | "threads.moveWorkspace" | "threads.movePreview" | "threads.restore" | "threads.restorePreview"> {
  return {
    "threads.delete": async ({ id }) => {
      // A phone deletes a cloud thread, which OpenOrc Cloud answers before it reaches here; never one of this Mac's.
      if (requestOrigin.getStore()?.kind === "phone") throw new Error(NOT_FROM_PHONE);
      const owner = orclings.forThread(db, id);
      if (owner) throw new Error(`This is ${owner.name}'s own conversation. Delete ${owner.name} to remove it.`);
      const release = teamTasks.releasing(id);
      await threadService.delete(id);
      release?.();
      upkeep.runsDeleted();
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
