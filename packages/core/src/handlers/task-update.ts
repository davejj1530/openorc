import { boardColumns, Db, tasks, threads } from "@openorc/db";
import type { BoardJobs } from "../services/board-jobs.js";
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
  boardJobs: Pick<BoardJobs, "arrived">;
  invalidate: (keys: string[]) => void;
};

export function createTaskUpdateHandlers({ threadService, db, runService, workspaceWriters, workspaces, boardJobs, invalidate }: Dependencies): Pick<Handlers, "tasks.update"> {
  return {
    "tasks.update": async ({ id, patch }) => {
      const { task, project } = taskAndProject(db, id);
      if (task.retiredTeam) throw new Error("This item is no longer available.");
      if (patch.workspaceMode !== undefined) threadService.assertTaskWorkspaceEditable(task);
      const status = patch.columnId === undefined ? patch.status : columnStage(db, patch.columnId, task.projectId);
      const update = () =>
        db.transaction(() => {
          if (patch.workspaceMode !== undefined && task.executionThreadId) threads.update(db, task.executionThreadId, { workspaceMode: patch.workspaceMode });
          return tasks.update(db, id, { ...patch, ...(status ? { status } : {}), ...completionPatch(status) }, { explicitStatus: true });
        });
      // Claim the directory before changing visibility or deleting its files.
      const t =
        status === "archived" && task.worktreePath && !runService.liveRunForTask(id)
          ? await workspaceWriters.withLease(task.worktreePath, `archive task ${id}`, async (lease) => {
              await workspaces.cleanup(task, project, {}, lease);
              return update();
            })
          : update();
      invalidate(["tasks", `task:${id}`, "inbox"]);
      // Only a card put in a column starts its job. A status set by itself may be the work already under way.
      if (patch.columnId !== undefined && patch.columnId !== task.columnId) boardJobs.arrived(id, patch.columnId);
      return t;
    },
  };
}

/** A card put in a column takes that column's stage. */
function columnStage(db: Db, columnId: string, projectId: string) {
  const column = boardColumns.get(db, columnId);
  if (column?.projectId !== projectId) throw new Error("This column is no longer on the board.");
  return column.stage;
}

function completionPatch(status: Parameters<Handlers["tasks.update"]>[0]["patch"]["status"]): { completedAt?: number | null } {
  if (status === "done") return { completedAt: Date.now() };
  if (status && status !== "archived") return { completedAt: null };
  return {};
}
