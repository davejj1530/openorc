import type { threadCollaborationRpcParams } from "@openorc/protocol";
import type { Handlers } from "./types.js";

const elsewhere = (): never => {
  throw new Error("That conversation isn't on OpenOrc Cloud.");
};

/**
 * Working together is an OpenOrc Cloud thread's: PlaceRouter takes these calls to the thread's owner. A thread of this
 * Mac has no teammates in it, which a window reads as unsupported.
 */
export const threadCollaborationHandlers: Pick<Handlers, keyof typeof threadCollaborationRpcParams> = {
  "threads.collaboration": () => ({ supported: false }),
  "threads.authors": elsewhere,
  "threads.people": elsewhere,
  "threads.startQueued": elsewhere,
  "threads.retrySave": elsewhere,
  "threads.notes": elsewhere,
  "threads.postNote": elsewhere,
  "threads.readNotes": elsewhere,
};
