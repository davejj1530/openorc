import { Db, tasks } from "@openorc/db";
import type { Task } from "@openorc/protocol";
import type { RunService } from "../services/runs.js";
import { TaskCommentService } from "../services/task-comments.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  comments: Pick<TaskCommentService, "list" | "post" | "retry" | "cancel" | "execute">;
  threadService: Pick<ThreadService, "openTaskThread" | "executionThreadFor">;
  runService: Pick<RunService, "pending">;
};

/** Each task with what its own run waits for the person to approve, so the Tasks screen holds what needs them. */
function withApprovals(list: Task[], runService: Dependencies["runService"]): Task[] {
  const waiting = new Map(runService.pending().flatMap((pending) => (pending.taskId ? [[pending.taskId, pending.detail] as const] : [])));
  return list.map((task) => ({ ...task, approval: waiting.get(task.id) ?? null }));
}

export function createTaskQueriesHandlers({
  db,
  comments,
  threadService,
  runService,
}: Dependencies): Pick<
  Handlers,
  | "tasks.list"
  | "tasks.get"
  | "tasks.comments.list"
  | "tasks.comments.post"
  | "tasks.comments.retry"
  | "tasks.comments.cancel"
  | "tasks.comments.execute"
  | "tasks.openThread"
  | "tasks.executionThread"
> {
  return {
    "tasks.list": ({ projectId, threadId, statuses }) =>
      withApprovals(tasks.list(db, { ...(projectId ? { projectId } : {}), ...(threadId ? { threadId } : {}), ...(statuses ? { statuses } : {}) }), runService),
    "tasks.get": ({ id }) => {
      const task = tasks.get(db, id);
      return task && !task.retiredTeam ? withApprovals([task], runService)[0]! : null;
    },
    "tasks.comments.list": ({ taskId }) => comments.list(taskId),
    "tasks.comments.post": (input) => comments.post(input),
    "tasks.comments.retry": ({ taskId, attemptId }) => comments.retry(taskId, attemptId),
    "tasks.comments.cancel": async ({ taskId, attemptId }) => {
      await comments.cancel(taskId, attemptId);
      return null;
    },
    "tasks.comments.execute": async ({ taskId, attemptId }) => {
      await comments.execute(taskId, attemptId);
      return null;
    },
    "tasks.openThread": ({ taskId }) => threadService.openTaskThread(taskId),
    "tasks.executionThread": ({ taskId }) => threadService.executionThreadFor(taskId),
  };
}
