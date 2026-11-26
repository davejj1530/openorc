import { z } from "zod";
import { Task, TaskPriority, TaskStatus, ThreadChoice, WorkspaceMode } from "./domain.js";
import { SpaceId } from "./spaces.js";
import type { TaskEvent } from "./task-events.js";

/** A project's task documents: read, made and changed, with each one's history and the person's replies on it. */
export const taskRpcParams = {
  "tasks.list": z.object({ spaceId: SpaceId.optional(), threadId: z.string().optional(), projectId: z.string().optional(), statuses: z.array(TaskStatus).optional() }),
  "tasks.get": z.object({ id: z.string() }),
  "tasks.create": z
    .object({
      threadId: z.string().optional(),
      projectId: z.string(),
      title: z.string().min(1),
      spec: z.string().optional(),
      priority: TaskPriority.optional(),
      labels: z.array(z.string()).optional(),
      useWorktree: z.boolean().optional(),
      workspaceMode: WorkspaceMode.optional(),
      baseRef: z.string().optional(),
    })
    .refine((value) => value.workspaceMode === undefined || value.useWorktree === undefined || (value.workspaceMode === "worktree") === value.useWorktree, "workspaceMode and useWorktree must agree"),
  "tasks.update": z.object({
    id: z.string(),
    patch: z.object({
      title: z.string().min(1).optional(),
      spec: z.string().nullable().optional(),
      status: TaskStatus.optional(),
      /** A board move: the task takes the column's stage as its status. */
      columnId: z.string().optional(),
      priority: TaskPriority.optional(),
      labels: z.array(z.string()).optional(),
      workspaceMode: WorkspaceMode.optional(),
      /** The model and account the task's work runs on; null leaves them to whatever starts the work. */
      choice: ThreadChoice.nullable().optional(),
    }),
  }),
  "tasks.events": z.object({ taskId: z.string() }),
  /** The person's reply to an agent's update, one of the replies it offered. It reaches the agent's thread as their message. */
  "tasks.answerUpdate": z.object({ taskId: z.string(), eventId: z.number().int(), reply: z.string().min(1).max(40) }),
};

export interface TaskRpcResults {
  "tasks.list": Task[];
  "tasks.get": Task | null;
  "tasks.create": Task;
  "tasks.update": Task;
  /** The task's history, oldest first. */
  "tasks.events": TaskEvent[];
  "tasks.answerUpdate": null;
}
