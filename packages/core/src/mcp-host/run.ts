import { Db, runs } from "@openorc/db";
import { type McpHost } from "@openorc/mcp";
import { RunService } from "../services/runs.js";
import { TaskCommentService } from "../services/task-comments.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  runService: Pick<RunService, "isLive" | "requestUserInput" | "acceptsPlanWrite" | "writePlan" | "requestApproval">;
  db: Db;
  comments: Pick<TaskCommentService, "intent">;
  assertTeamActor: RunContext["assertTeamActor"];
};
export function createRunHost({ runService, db, comments, assertTeamActor }: Dependencies): Pick<McpHost, "live" | "commentTurn" | "askUser" | "plan" | "approve"> {
  return {
    live: (runId) => runService.isLive(runId),
    commentTurn: { isComment: (runId) => Boolean(runs.get(db, runId)?.commentTurnId), intent: (runId, input) => comments.intent(runId, input) },
    askUser: (runId, requestId, input, signal) => {
      assertTeamActor(runId);
      return runService.requestUserInput(runId, requestId, input, signal);
    },
    plan: {
      available: (runId) => runService.acceptsPlanWrite(runId),
      write: async (runId, text) => {
        assertTeamActor(runId);
        runService.writePlan(runId, text);
      },
    },
    approve: async ({ runId, approvalId, toolName, input }) => {
      try {
        assertTeamActor(runId);
      } catch (error) {
        return { decision: "deny", message: String(error) };
      }
      return runService.requestApproval(runId, approvalId, toolName, input);
    },
  };
}
