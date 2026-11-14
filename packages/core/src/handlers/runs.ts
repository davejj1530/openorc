import { Db, retiredTeams, runs } from "@openorc/db";
import { LiveInputUnavailable } from "@openorc/agents";
import { AttachmentService } from "../services/attachments.js";
import { RunService } from "../services/runs.js";
import { ThreadService } from "../services/threads.js";
import { taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "continueThread" | "startTaskInThread" | "conversationRuns" | "queue">;
  runService: Pick<RunService, "send" | "interrupt" | "close" | "subagents" | "resolveApproval">;
  db: Db;
  dataDir: string;
};

export function createRunsHandlers({
  threadService,
  runService,
  db,
  dataDir,
}: Dependencies): Pick<Handlers, "runs.start" | "runs.send" | "runs.interrupt" | "runs.close" | "runs.listForTask" | "runs.listForThread" | "subagents.stop" | "approvals.resolve"> {
  /** A message from the person into a run: into the running turn when it can take one, else queued for the thread. */
  const deliver = async (runId: string, text: string, attachments?: string[], messageId?: string) => {
    try {
      await runService.send(runId, text, { attachments, messageId });
    } catch (error) {
      if (!(error instanceof LiveInputUnavailable)) throw error;
      const threadId = runs.get(db, runId)?.threadId;
      if (!threadId) throw error;
      threadService.queue(threadId, text, attachments ?? []);
    }
  };
  return {
    "subagents.stop": async ({ threadId }) => {
      await runService.subagents.stop(threadId);
      return null;
    },
    "runs.start": async ({ taskId, threadId, workspaceMode, agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, resume, claudeAccountId, messageId }) => {
      if (threadId)
        return threadService.continueThread(threadId, {
          agent,
          model,
          effort,
          fastMode,
          attachments,
          mode,
          permissionMode,
          prompt,
          fresh: resume === false,
          claudeAccountId,
          promptMessageId: messageId,
        });
      if (!taskId) throw new Error("runs.start needs a taskId or a threadId");
      if (claudeAccountId) throw new Error("A task goes on with the Claude account it ran on.");
      const { task } = taskAndProject(db, taskId);
      const images = await new AttachmentService(dataDir).forTask(task.spec ?? "");
      return threadService.startTaskInThread(taskId, workspaceMode, images, { agent, model, effort, fastMode, attachments, mode, permissionMode, prompt, fresh: resume === false });
    },
    "runs.send": async ({ runId, text, attachments, messageId }) => {
      await deliver(runId, text, attachments, messageId);
      return null;
    },
    // Not every agent takes words with a denial, so a note goes the one way every agent takes words mid-turn: as the
    // person's next message to the same run, right after the denial.
    "approvals.resolve": async ({ runId, approvalId, decision, answers, note }) => {
      runService.resolveApproval(runId, approvalId, decision, answers);
      if (note && decision === "deny") await deliver(runId, note);
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
