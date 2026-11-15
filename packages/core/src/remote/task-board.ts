import { tasks, type Db } from "@openorc/db";
import type { BoardTask, Task, TaskBoard, TaskStatus } from "@openorc/protocol";

/** The tasks a board shows: not done, not archived. */
const OPEN_TASKS: TaskStatus[] = ["proposed", "backlog", "in_progress", "review"];

const onBoard = ({ id, projectId, title, status, priority, threadId, executionThreadId, updatedAt }: Task): BoardTask => ({
  id,
  projectId,
  title,
  status,
  priority,
  threadId,
  executionThreadId,
  updatedAt,
});

/** What a phone's task list shows of this Mac: its open tasks. `mac` was a cloud brain's copy of its Mac's, which a Mac never had. */
export function taskBoard(db: Db): TaskBoard {
  return { tasks: tasks.list(db, { statuses: OPEN_TASKS }).map(onBoard), mac: null };
}
