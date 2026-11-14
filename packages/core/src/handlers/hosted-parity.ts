import type { hostedParityRpcParams } from "@openorc/protocol";
import type { Handlers } from "./types.js";

const unavailable = (): never => {
  throw new Error("That conversation isn't available on OpenOrc Cloud.");
};

/** Desktop requests reach their owner in PlaceRouter. No host-local implementation may substitute for it. */
export const hostedParityHandlers: Pick<Handlers, keyof typeof hostedParityRpcParams> = {
  "hosted.capabilities": unavailable,
  "hosted.review.changes": unavailable,
  "hosted.review.turn": unavailable,
  "hosted.review.file": unavailable,
  "hosted.review.state": unavailable,
  "hosted.review.action": unavailable,
};
