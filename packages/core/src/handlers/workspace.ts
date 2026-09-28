import { Db } from "@openorc/db";
import { RunService } from "../services/runs.js";
import { WorkspaceService } from "../services/workspace.js";
import { taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  runService: Pick<RunService, "liveRunForTask">;
  workspaces: Pick<WorkspaceService, "cleanup" | "removalImpact" | "usage" | "prepare">;
  db: Db;
  invalidate: (keys: string[]) => void;
};

export function createWorkspaceHandlers({
  runService,
  workspaces,
  db,
  invalidate,
}: Dependencies): Pick<Handlers, "workspace.cleanup" | "workspace.removalImpact" | "workspace.usage" | "tasks.prepareWorkspace"> {
  return {
    "workspace.cleanup": async ({ taskId, deleteBranch, acceptLoss }) => {
      const { task, project } = taskAndProject(db, taskId);
      if (runService.liveRunForTask(taskId)) throw new Error("a run is still live on this task; end it first");
      const t = await workspaces.cleanup(task, project, { deleteBranch: deleteBranch ?? false, ...(acceptLoss ? { acceptLoss } : {}) });
      invalidate(["tasks", `task:${taskId}`, `diff:${taskId}`]);
      return t;
    },
    "workspace.removalImpact": async ({ taskId }) => {
      const { task, project } = taskAndProject(db, taskId);
      return workspaces.removalImpact(task, project);
    },
    "workspace.usage": async ({ taskId }) => {
      const { task } = taskAndProject(db, taskId);
      return { bytes: await workspaces.usage(task) };
    },
    "tasks.prepareWorkspace": async ({ taskId }) => {
      const { task, project } = taskAndProject(db, taskId);
      const t = await workspaces.prepare(task, project);
      invalidate(["tasks", `task:${taskId}`]);
      return t;
    },
  };
}
