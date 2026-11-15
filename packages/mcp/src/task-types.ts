import { OnlineTaskRef, type OnlineTaskToolReference, type TaskStatus } from "@openorc/protocol";
import { z } from "zod";

export const TaskScope = OnlineTaskRef.pick({ spaceId: true, projectId: true }).strict();
export type TaskScope = z.infer<typeof TaskScope>;
export interface TaskContextOptions {
  scope?: TaskScope;
  taskId?: string;
}

export interface TaskCard {
  spec?: string | null;
  message?: string;
  id: string;
  taskRef?: OnlineTaskToolReference;
  revision?: number;
  title: string;
  status: string;
  branch: string | null;
  /** True when this is the task the calling run is executing. */
  current: boolean;
  resultSummary: string | null;
  activity?: {
    runId: string;
    state: "working" | "waiting" | "idle" | "completed" | "failed" | "cancelled";
    latestMessage: string | null;
    lastAction: string | null;
    waitingFor: string | null;
    updatedAt: number;
  } | null;
}

export interface TaskTools {
  /** Creates a task in the caller's thread, or returns the existing one when the title matches. */
  create(
    runId: string,
    input: {
      scope?: TaskScope;
      title: string;
      spec: string;
      priority?: string;
      labels?: string[];
      execution?: "backlog" | "delegate";
      workspaceMode?: "current" | "worktree";
    },
  ): Promise<{ task: TaskCard; duplicate: boolean; started: boolean; message: string }>;
  start(runId: string, id: string, options?: { workspaceMode?: "current" | "worktree"; scope?: TaskScope; ifRevision?: number }): Promise<TaskCard>;
  list(runId: string, scope?: TaskScope): Promise<TaskCard[]>;
  get(runId: string, id: string, scope?: TaskScope): Promise<TaskCard | null>;
  update(runId: string, id: string, patch: { status?: TaskStatus; spec?: string; scope?: TaskScope; ifRevision?: number }): Promise<TaskCard | null>;
}
