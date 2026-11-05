import { frozenMoving, type Db } from "@openorc/db";
import { MOVING_WORDS } from "@openorc/protocol";

/** Refuses a write to a thread frozen on this host while it relocates. */
export function assertNotMoving(db: Db, threadId: string): void {
  const moving = frozenMoving(db, threadId);
  if (moving) throw new Error(MOVING_WORDS[moving.to]);
}
