import { orchestration, type Db } from "@openorc/db";
import { isDetachedCopy, type Thread } from "@openorc/protocol";

/**
 * Whether a conversation works in a copy of someone else's code, such as a pull request under review: a copy on no
 * branch outside a team, which publishes through a branch of its own. Forks of a review and archived rounds share
 * the copy, so this follows the copy, not the link to the review.
 */
export function inUnvettedCopy(db: Db, thread: Thread): boolean {
  return isDetachedCopy(thread) && !orchestration.getInstance(db, thread.id);
}
