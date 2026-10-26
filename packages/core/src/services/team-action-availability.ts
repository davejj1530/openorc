import { teamForks, teamMoves, teamRestores, type Db } from "@openorc/db";
import type { ReviewService } from "./review.js";
import type { TeamDeletionService } from "./team-deletions.js";
import type { TeamForkService } from "./team-forks.js";
import type { TeamMoveService } from "./team-moves.js";
import type { TeamRestoreService } from "./team-restores.js";

export interface TeamActionServices {
  db: Db;
  review: Pick<ReviewService, "teamActionAvailability">;
  teamForks: Pick<TeamForkService, "availability">;
  teamRestores: Pick<TeamRestoreService, "availability">;
  teamMoves: Pick<TeamMoveService, "availability">;
  teamDeletions: Pick<TeamDeletionService, "availability" | "recovery">;
}

/** What a team conversation's Git, fork, restore, move and delete controls may do, with any recovery each left pending. */
export function teamActionAvailability(services: TeamActionServices, id: string) {
  const availability = services.review.teamActionAvailability(id);
  const pending = teamForks.pendingForThread(services.db, id)[0];
  const restore = teamRestores.pendingForThread(services.db, id)[0];
  const move = teamMoves.pendingForThread(services.db, id)[0];
  const deleteRecovery = services.teamDeletions.recovery(id);
  return {
    commit: availability,
    push: availability,
    createPr: availability,
    fork: services.teamForks.availability(id),
    restore: services.teamRestores.availability(id),
    move: services.teamMoves.availability(id),
    delete: services.teamDeletions.availability(id),
    ...(deleteRecovery ? { deleteRecovery } : {}),
    ...(move ? { moveRecovery: { requestKey: move.requestKey, to: move.to, error: move.error, cancelRequested: move.cancelRequested } } : {}),
    ...(restore ? { restoreRecovery: { requestKey: restore.requestKey, checkpointId: restore.checkpointId, error: restore.error } } : {}),
    ...(pending ? { forkRecovery: { requestKey: pending.requestKey, upToRunId: pending.upToRunId, error: pending.error } } : {}),
  };
}
