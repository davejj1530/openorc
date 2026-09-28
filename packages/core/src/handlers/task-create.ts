import { Db, projects, tasks, threads } from "@openorc/db";
import { AttachmentService } from "../services/attachments.js";
import { AppSettingsService } from "../services/settings.js";
import { ThreadService } from "../services/threads.js";
import { taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  settings: Pick<AppSettingsService, "get">;
  threadService: Pick<ThreadService, "startTaskInThread">;
  invalidate: (keys: string[]) => void;
  dataDir: string;
};

export function createTaskCreateHandlers({ db, settings, threadService, invalidate, dataDir }: Dependencies): Pick<Handlers, "tasks.create" | "tasks.start"> {
  return {
    "tasks.create": ({ projectId, threadId, title, spec, priority, labels, useWorktree, workspaceMode, baseRef }) => {
      const project = projects.get(db, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      const parent = threadId ? threads.get(db, threadId) : null;
      if (threadId && (!parent || parent.projectId !== projectId)) throw new Error("The parent thread must belong to this project.");
      const selectedWorkspaceMode = taskWorkspaceMode({ workspaceMode, useWorktree, parent, settings });
      const t = tasks.insert(db, {
        projectId,
        title,
        spec: spec ?? null,
        priority: priority ?? "none",
        labels: labels ?? [],
        workspaceMode: selectedWorkspaceMode,
        baseRef: baseRef ?? (parent?.worktreePath ? parent.branch : null) ?? project.defaultBranch,
        parentTaskId: null,
        threadId: threadId ?? null,
        origin: "user",
      });
      invalidate(["tasks", ...(threadId ? ["threads", `thread:${threadId}`] : [])]);
      return t;
    },
    "tasks.start": async ({ taskId, workspaceMode }) => {
      const { task } = taskAndProject(db, taskId);
      const images = await new AttachmentService(dataDir).forTask(task.spec ?? "");
      return threadService.startTaskInThread(taskId, workspaceMode, images);
    },
  };
}

function taskWorkspaceMode({
  workspaceMode,
  useWorktree,
  parent,
  settings,
}: {
  workspaceMode: Parameters<Handlers["tasks.create"]>[0]["workspaceMode"];
  useWorktree: boolean | undefined;
  parent: ReturnType<typeof threads.get>;
  settings: Dependencies["settings"];
}) {
  if (workspaceMode !== undefined) return workspaceMode;
  if (useWorktree !== undefined) return useWorktree ? "worktree" : "current";
  return parent?.workspaceMode ?? settings.get().defaultWorkspaceMode;
}
