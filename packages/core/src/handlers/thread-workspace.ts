import { Db, orchestration, orclings, teamDeletions, teamForks, teamMoves, teamRestores } from "@openorc/db";
import { LedgerUpkeep } from "../services/ledger-upkeep.js";
import { TeamDeletionService } from "../services/team-deletions.js";
import { TeamForkService } from "../services/team-forks.js";
import { TeamMoveService } from "../services/team-moves.js";
import { TeamRestoreService } from "../services/team-restores.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  teamDeletionsService: Pick<TeamDeletionService, "delete" | "cancel">;
  threadService: Pick<ThreadService, "delete" | "fork" | "moveWorkspace" | "movePreview" | "restore" | "restorePreview">;
  upkeep: Pick<LedgerUpkeep, "forgetDeletedRuns">;
  teamForksService: Pick<TeamForkService, "fork" | "cancel">;
  teamMovesService: Pick<TeamMoveService, "move" | "cancel">;
  teamRestoresService: Pick<TeamRestoreService, "restore" | "cancel">;
};

export function createThreadWorkspaceHandlers({
  db,
  teamDeletionsService,
  threadService,
  upkeep,
  teamForksService,
  teamMovesService,
  teamRestoresService,
}: Dependencies): Pick<
  Handlers,
  "threads.delete" | "threads.fork" | "threads.moveWorkspace" | "threads.movePreview" | "threads.cancelMove" | "threads.cancelTeamOperation" | "threads.restore" | "threads.restorePreview"
> {
  return {
    "threads.delete": async ({ id, requestKey }) => {
      const owner = orclings.forThread(db, id);
      if (owner) throw new Error(`This is ${owner.name}'s own conversation. Delete ${owner.name} to remove it.`);
      // A finished taskless deletion has no instance left; its receipt still answers the replayed key.
      if (orchestration.getInstance(db, id) || (requestKey && (teamDeletions.find(db, id, requestKey) || teamDeletions.rejection(db, id, requestKey)))) {
        if (!requestKey) throw new Error("Deleting a team conversation needs a request key so an interrupted delete can be retried safely.");
        return teamDeletionsService.delete({ threadId: id, requestKey });
      }
      await threadService.delete(id);
      await upkeep.forgetDeletedRuns();
      return null;
    },
    "threads.fork": ({ id, upToRunId, requestKey }) => {
      if (!orchestration.getInstance(db, id) && !(requestKey && (teamForks.find(db, id, requestKey) || teamForks.rejection(db, id, requestKey)))) return threadService.fork(id, upToRunId);
      if (!requestKey) throw new Error("Forking a team needs a request key so an interrupted response can be recovered.");
      return teamForksService.fork({ threadId: id, upToRunId, requestKey });
    },
    "threads.moveWorkspace": ({ id, to, requestKey }) => {
      if (!orchestration.getInstance(db, id) && !(requestKey && (teamMoves.find(db, id, requestKey) || teamMoves.rejection(db, id, requestKey)))) return threadService.moveWorkspace(id, to);
      if (!requestKey) throw new Error("Moving a team needs a request key so an interrupted response can be recovered.");
      return teamMovesService.move({ threadId: id, to, requestKey });
    },
    "threads.movePreview": ({ id, to }) => (orchestration.getInstance(db, id) ? { files: [], blocked: "A team conversation moves through its own move dialog." } : threadService.movePreview(id, to)),
    "threads.cancelMove": ({ id, requestKey }) => teamMovesService.cancel(id, requestKey),
    "threads.cancelTeamOperation": ({ id, kind, requestKey, keepFiles }) => {
      if (kind === "delete") return teamDeletionsService.cancel(id, requestKey, keepFiles);
      if (keepFiles !== undefined) throw new Error("The keep-files choice is only available for deletion.");
      if (kind === "fork") return teamForksService.cancel(id, requestKey);
      return teamRestoresService.cancel(id, requestKey);
    },
    "threads.restore": async ({ id, checkpointId, requestKey }) => {
      if (orchestration.getInstance(db, id) || (requestKey && (teamRestores.find(db, id, requestKey) || teamRestores.rejection(db, id, requestKey)))) {
        if (!requestKey) throw new Error("Restoring a team needs a request key so an interrupted response can be recovered.");
        return teamRestoresService.restore({ threadId: id, checkpointId, requestKey });
      } else await threadService.restore(id, checkpointId);
      return null;
    },
    "threads.restorePreview": ({ id, checkpointId }) =>
      orchestration.getInstance(db, id) ? { files: [], blocked: "A team conversation restores into a new team workspace." } : threadService.restorePreview(id, checkpointId),
  };
}
