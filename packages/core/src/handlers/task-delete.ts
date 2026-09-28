import { Db, tasks } from "@openorc/db";
import { snapshotRefs, unpinProjectRefs } from "../services/checkpoint-refs.js";
import { LedgerUpkeep } from "../services/ledger-upkeep.js";
import { RunService } from "../services/runs.js";
import { TaskCommentService } from "../services/task-comments.js";
import { WorkspaceService, assertLossAccepted } from "../services/workspace.js";
import { type Logger } from "../transport.js";
import { taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  workspaces: Pick<WorkspaceService, "removalImpact" | "cleanup">;
  comments: Pick<TaskCommentService, "deleteTask">;
  runService: Pick<RunService, "liveRunForTask" | "closeAndWait">;
  db: Db;
  log: Pick<Logger, "warn">;
  upkeep: Pick<LedgerUpkeep, "forgetDeletedRuns">;
  invalidate: (keys: string[]) => void;
};

export function createTaskDeleteHandlers({ workspaces, comments, runService, db, log, upkeep, invalidate }: Dependencies): Pick<Handlers, "tasks.delete"> {
  return {
    "tasks.delete": async ({ id, deleteBranch, acceptLoss }) => {
      const { task, project } = taskAndProject(db, id);
      // Refused before anything goes; the cleanup checks again under its workspace lease.
      if (deleteBranch) assertLossAccepted(await workspaces.removalImpact(task, project), acceptLoss);
      await comments.deleteTask(id);
      const live = runService.liveRunForTask(id);
      if (live) await runService.closeAndWait(live.id);
      await workspaces.cleanup(task, project, { deleteBranch: deleteBranch ?? false, force: true, ...(acceptLoss ? { acceptLoss } : {}) });
      tasks.delete(db, id);
      await unpinProjectRefs(project, snapshotRefs(id)).catch((e: unknown) => log.warn(`snapshot refs of task ${id} were kept: ${e instanceof Error ? e.message : String(e)}`));
      await upkeep.forgetDeletedRuns();
      invalidate(["tasks", "inbox"]);
      return null;
    },
  };
}
