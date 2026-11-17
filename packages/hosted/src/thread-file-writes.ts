import { HOSTED_REASONS } from "@openorc/protocol";
import { Refused } from "./session.js";
import type { Threads } from "./threads.js";
import { ROUTES, type WireFileWrite, type WireFileWriteOutcome } from "./wire.js";

/**
 * Writes one file of a cloud thread's checkout on its machine, as its host makes it there, and answers how it ended. A
 * server that writes no files says so in the app's words.
 */
export function writeThreadFile(threads: Threads, threadId: string, write: WireFileWrite): Promise<WireFileWriteOutcome> {
  return threads
    .on(threadId)
    .request(ROUTES.writeFile(threadId), write)
    .catch((error: unknown) => {
      if (error instanceof Refused && (error.status === 404 || error.status === 503)) throw new Refused(HOSTED_REASONS.fileWrite);
      throw error;
    });
}
