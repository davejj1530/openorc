import type { CloudMoves } from "../services/cloud-moves.js";
import type { Handlers } from "./types.js";

/** A thread moving between this Mac and OpenOrc Cloud: whether it can, the move itself, and putting away why one stopped. */
export function createCloudMovesHandlers(moves: () => CloudMoves): Pick<Handlers, "threads.moveCheck" | "threads.move" | "threads.moveDismiss"> {
  return {
    "threads.moveCheck": ({ threadId }) => moves().check(threadId),
    "threads.move": ({ threadId, endsOk }) => moves().move(threadId, endsOk),
    "threads.moveDismiss": ({ threadId }) => {
      moves().dismiss(threadId);
      return null;
    },
  };
}
