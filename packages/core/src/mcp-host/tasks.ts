import { type McpHost } from "@openorc/mcp";
import { AttachmentService } from "../services/attachments.js";
import { TeamCoordinator } from "../services/team-coordinator.js";
import { TeamTaskService } from "../services/team-tasks.js";
import { ThreadService } from "../services/threads.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  teams: Pick<TeamCoordinator, "binding">;
  threadService: Pick<ThreadService, "toolGet" | "toolStart" | "toolList" | "toolUpdate">;
  teamTasks: Pick<TeamTaskService, "toolStart" | "completeTask">;
  dataDir: string;
  assertTeamActor: RunContext["assertTeamActor"];
};
export function createTasksHost({ teams, threadService, teamTasks, dataDir, assertTeamActor }: Dependencies): Omit<McpHost["tasks"], "create"> {
  return {
    start: async (runId, id, options) => {
      assertTeamActor(runId);
      if (!teams.binding(runId)) {
        if (options && [options.admissionId, options.memberKey, options.requestKey].some((value) => value !== undefined)) throw new Error("Team assignment fields require an authenticated team run.");
        const scoped = await threadService.toolGet(runId, id);
        if (!scoped) throw new Error("Task not found in this agent's project.");
        const images = await new AttachmentService(dataDir).forTask(scoped.spec ?? "");
        const task = await threadService.toolStart(runId, id, options?.workspaceMode);
        return images.length ? { ...task, message: `${task.message}\nTask images (open these paths):\n${images.join("\n")}` } : task;
      }
      if (options?.workspaceMode !== undefined) throw new Error("Team assignments use their team workspace policy; workspace_mode is only for ordinary tasks.");
      const accepted = await teamTasks.toolStart(runId, { taskId: id, ...options });
      const task = (await threadService.toolGet(runId, id))!;
      return {
        ...task,
        ...(accepted ? { admissionId: accepted.admissionId, message: "Accepted task routing is retained. Use team_wait and end your turn to release capacity for assigned agents." } : {}),
      };
    },
    complete: async (runId, input) => {
      assertTeamActor(runId);
      if (!teams.binding(runId)) throw new Error("task_complete requires an authenticated team assignment.");
      teamTasks.completeTask(runId, input);
      return { recorded: true, message: "Completion intent recorded. End this turn successfully to capture the task result." };
    },
    list: (runId) => {
      assertTeamActor(runId);
      return threadService.toolList(runId);
    },
    get: (runId, id) => {
      assertTeamActor(runId);
      return threadService.toolGet(runId, id);
    },
    update: (runId, id, patch) => {
      assertTeamActor(runId);
      return threadService.toolUpdate(runId, id, patch);
    },
  };
}
