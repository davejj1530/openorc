import type { CloudMoves } from "../services/cloud-moves.js";
import type { Handlers } from "./types.js";

/** A thread moving between this Mac and OpenOrc Cloud: whether it can, and the move itself. */
export function createCloudMovesHandlers(moves: () => CloudMoves): Pick<Handlers, "threads.moveCheck" | "threads.move"> {
  return {
    "threads.moveCheck": ({ threadId }) => moves().check(threadId),
    "threads.move": ({ threadId, endsOk }) => moves().move(threadId, endsOk),
  };
}
