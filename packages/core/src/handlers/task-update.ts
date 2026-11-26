import { boardColumns, Db, tasks, threads } from "@openorc/db";
import type { Task, ThreadChoice } from "@openorc/protocol";
import type { BoardJobs } from "../services/board-jobs.js";
import { assertOnTaskAccount } from "../services/claude-account-separation.js";
import { startingAccount } from "../services/project-claude-accounts.js";
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
      if (patch.choice) assertTaskChoice(db, task, patch.choice);
      const columnId = patch.columnId ?? stageColumn(db, task, patch.status);
      const status = columnId === undefined ? patch.status : columnStage(db, columnId, task.projectId);
      const update = () =>
        db.transaction(() => {
          if (patch.workspaceMode !== undefined && task.executionThreadId) threads.update(db, task.executionThreadId, { workspaceMode: patch.workspaceMode });
          return tasks.update(db, id, { ...patch, ...(columnId ? { columnId } : {}), ...(status ? { status } : {}), ...completionPatch(status) }, { explicitStatus: true, by: { kind: "user" } });
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
      // A card put in a column starts its agent, whether the person named the column or the status it stands for.
      if (columnId !== undefined && columnId !== task.columnId) boardJobs.arrived(id, columnId, { from: task.columnId ?? null, by: { kind: "user" } });
      return t;
    },
  };
}

/** A Claude account set for a task's work is one its project uses, and the task's own while accounts are kept separate. */
function assertTaskChoice(db: Db, task: Task, choice: ThreadChoice): void {
  if (choice.agent !== "claude" || !choice.claudeAccountId) return;
  assertOnTaskAccount(db, task, startingAccount(db, task.projectId, choice.claudeAccountId, "chosen"));
}

/**
 * A status a person sets is a move on the board: on a board with its own columns the card goes to the first column of
 * that stage, as it is drawn there, so a list or a phone, which show no columns, start the same agents the board does.
 * Undefined where nothing moves: the status is the task's own, or no column of the board stands for it.
 */
function stageColumn(db: Db, task: Task, status: Task["status"] | undefined): string | undefined {
  if (status === undefined || status === task.status) return undefined;
  return boardColumns.list(db, task.projectId).find((column) => column.stage === status)?.id;
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
