import { Db, runs } from "@openorc/db";
import { randomUUID } from "node:crypto";
import { AttachmentService } from "../services/attachments.js";
import { RunService } from "../services/runs.js";
import { TeamCoordinator } from "../services/team-coordinator.js";
import { ThreadService } from "../services/threads.js";
import { taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "continueThread" | "startTaskInThread" | "conversationRuns">;
  teams: Pick<TeamCoordinator, "binding" | "steer" | "stop">;
  runService: Pick<RunService, "send" | "interrupt" | "close">;
  db: Db;
  dataDir: string;
};

export function createRunsHandlers({
  threadService,
  teams,
  runService,
  db,
  dataDir,
}: Dependencies): Pick<Handlers, "runs.start" | "runs.send" | "runs.interrupt" | "runs.close" | "runs.listForTask" | "runs.listForThread"> {
  return {
    "runs.start": async ({ taskId, threadId, workspaceMode, agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, resume }) => {
      if (threadId) return threadService.continueThread(threadId, { agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, fresh: resume === false });
      if (!taskId) throw new Error("runs.start needs a taskId or a threadId");
      const { task } = taskAndProject(db, taskId);
      const images = await new AttachmentService(dataDir).forTask(task.spec ?? "");
      return threadService.startTaskInThread(taskId, workspaceMode, images, { agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, fresh: resume === false });
    },
    "runs.send": async ({ runId, text, attachments }) => {
      const binding = teams.binding(runId);
      if (binding) {
        if (binding.actorId !== "lead") throw new Error("This team feedback path is not available yet. Send direction to the lead.");
        teams.steer(binding.executionId, { text, attachments, requestKey: randomUUID() });
        return null;
      }
      await runService.send(runId, text, { attachments });
      return null;
    },
    "runs.interrupt": async ({ runId }) => {
      const binding = teams.binding(runId);
      if (binding) {
        await teams.stop(binding.executionId);
        return null;
      }
      await runService.interrupt(runId);
      return null;
    },
    "runs.close": async ({ runId }) => {
      const binding = teams.binding(runId);
      if (binding) {
        await teams.stop(binding.executionId);
        return null;
      }
      runService.close(runId);
      return null;
    },
    "runs.listForTask": ({ taskId }) => runs.listForTask(db, taskId),
    "runs.listForThread": ({ threadId }) => threadService.conversationRuns(threadId),
  };
}
