import { Db, orchestration, tasks, teamRuntime, threads } from "@openorc/db";
import { RunService } from "../services/runs.js";
import { ThreadService } from "../services/threads.js";
import { WorkspaceWriters } from "../services/workspace-writers.js";
import { WorkspaceService } from "../services/workspace.js";
import { taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "assertTaskWorkspaceEditable">;
  db: Db;
  runService: Pick<RunService, "liveRunForTask">;
  workspaceWriters: Pick<WorkspaceWriters, "withLease">;
  workspaces: Pick<WorkspaceService, "cleanup">;
  invalidate: (keys: string[]) => void;
};

export function createTaskUpdateHandlers({ threadService, db, runService, workspaceWriters, workspaces, invalidate }: Dependencies): Pick<Handlers, "tasks.update"> {
  return {
    "tasks.update": async ({ id, patch }) => {
      const { task, project } = taskAndProject(db, id);
      if (patch.workspaceMode !== undefined) threadService.assertTaskWorkspaceEditable(task);
      const update = () =>
        db.transaction(() => {
          if (patch.workspaceMode !== undefined && task.executionThreadId) threads.update(db, task.executionThreadId, { workspaceMode: patch.workspaceMode });
          return tasks.update(db, id, { ...patch, ...completionPatch(patch.status) }, { explicitStatus: true });
        });
      const teamOwned = Boolean(teamRuntime.assignmentForTask(db, id) || (task.threadId && orchestration.getInstance(db, task.threadId)));
      // Claim the directory before changing visibility or deleting its files.
      // Moving a team task never stops its execution or cleans its workspace.
      const t =
        patch.status === "archived" && !teamOwned && task.worktreePath && !runService.liveRunForTask(id)
          ? await workspaceWriters.withLease(task.worktreePath, `archive task ${id}`, async (lease) => {
              await workspaces.cleanup(task, project, {}, lease);
              return update();
            })
          : update();
      invalidate(["tasks", `task:${id}`, "inbox"]);
      return t;
    },
  };
}

function completionPatch(status: Parameters<Handlers["tasks.update"]>[0]["patch"]["status"]): { completedAt?: number | null } {
  if (status === "done") return { completedAt: Date.now() };
  if (status && status !== "archived") return { completedAt: null };
  return {};
}
