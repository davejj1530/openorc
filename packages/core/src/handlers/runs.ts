import { Db, retiredTeams, runs } from "@openorc/db";
import { AttachmentService } from "../services/attachments.js";
import { RunService } from "../services/runs.js";
import { ThreadService } from "../services/threads.js";
import { taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "continueThread" | "startTaskInThread" | "conversationRuns">;
  runService: Pick<RunService, "send" | "interrupt" | "close" | "subagents">;
  db: Db;
  dataDir: string;
};

export function createRunsHandlers({
  threadService,
  runService,
  db,
  dataDir,
}: Dependencies): Pick<Handlers, "runs.start" | "runs.send" | "runs.interrupt" | "runs.close" | "runs.listForTask" | "runs.listForThread" | "subagents.stop"> {
  return {
    "subagents.stop": async ({ threadId }) => {
      await runService.subagents.stop(threadId);
      return null;
    },
    "runs.start": async ({ taskId, threadId, workspaceMode, agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, resume, claudeAccountId }) => {
      if (threadId) return threadService.continueThread(threadId, { agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, fresh: resume === false, claudeAccountId });
      if (!taskId) throw new Error("runs.start needs a taskId or a threadId");
      if (claudeAccountId) throw new Error("A task goes on with the Claude account it ran on.");
      const { task } = taskAndProject(db, taskId);
      const images = await new AttachmentService(dataDir).forTask(task.spec ?? "");
      return threadService.startTaskInThread(taskId, workspaceMode, images, { agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, fresh: resume === false });
    },
    "runs.send": async ({ runId, text, attachments }) => {
      await runService.send(runId, text, { attachments });
      return null;
    },
    "runs.interrupt": async ({ runId }) => {
      await runService.interrupt(runId);
      return null;
    },
    "runs.close": async ({ runId }) => {
      runService.close(runId);
      return null;
    },
    "runs.listForTask": ({ taskId }) => (retiredTeams.hasTask(db, taskId) ? [] : runs.listForTask(db, taskId)),
    "runs.listForThread": ({ threadId }) => threadService.conversationRuns(threadId),
  };
}
