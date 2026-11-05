import { frozenMoving, type Db } from "@openorc/db";
import { MOVING_WORDS, type Task } from "@openorc/protocol";

/** Refuses a write to a thread frozen on this host while it relocates. */
export function assertNotMoving(db: Db, threadId: string): void {
  const moving = frozenMoving(db, threadId);
  if (moving) throw new Error(MOVING_WORDS[moving.to]);
}

/** Refuses a write to a task whose thread is frozen while it relocates: the task moves with the thread doing its work. */
export function assertTaskNotMoving(db: Db, task: Pick<Task, "threadId" | "executionThreadId">): void {
  const owner = task.executionThreadId ?? task.threadId;
  if (owner) assertNotMoving(db, owner);
}
