import { Db, tasks } from "@openorc/db";
import { TaskCommentService } from "../services/task-comments.js";
import { TaskForwardingService } from "../services/task-forwarding.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  comments: Pick<TaskCommentService, "list" | "post" | "retry" | "cancel" | "execute">;
  threadService: Pick<ThreadService, "openTaskThread" | "executionThreadFor">;
  taskForwarding: Pick<TaskForwardingService, "state" | "forward">;
};

export function createTaskQueriesHandlers({
  db,
  comments,
  threadService,
  taskForwarding,
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
  | "tasks.forwarding"
  | "tasks.forward"
> {
  return {
    "tasks.list": ({ projectId, threadId, statuses }) => tasks.list(db, { ...(projectId ? { projectId } : {}), ...(threadId ? { threadId } : {}), ...(statuses ? { statuses } : {}) }),
    "tasks.get": ({ id }) => tasks.get(db, id),
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
    "tasks.forwarding": ({ taskId }) => taskForwarding.state(taskId),
    "tasks.forward": ({ taskId, workspaceMode }) => taskForwarding.forward(taskId, workspaceMode),
  };
}
