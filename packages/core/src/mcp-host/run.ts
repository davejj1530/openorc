import { Db, runs } from "@openorc/db";
import { type McpHost } from "@openorc/mcp";
import { RunService } from "../services/runs.js";
import { TaskCommentService } from "../services/task-comments.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  runService: Pick<RunService, "isLive" | "requestUserInput" | "acceptsPlanWrite" | "writePlan" | "requestApproval">;
  db: Db;
  comments: Pick<TaskCommentService, "intent">;
  assertRunAvailable: RunContext["assertRunAvailable"];
};
export function createRunHost({ runService, db, comments, assertRunAvailable }: Dependencies): Pick<McpHost, "live" | "commentTurn" | "askUser" | "plan" | "approve"> {
  return {
    live: (runId) => runService.isLive(runId),
    commentTurn: { isComment: (runId) => Boolean(runs.get(db, runId)?.commentTurnId), intent: (runId, input) => comments.intent(runId, input) },
    askUser: (runId, requestId, input, signal) => {
      assertRunAvailable(runId);
      return runService.requestUserInput(runId, requestId, input, signal);
    },
    plan: {
      available: (runId) => runService.acceptsPlanWrite(runId),
      write: async (runId, text) => {
        assertRunAvailable(runId);
        runService.writePlan(runId, text);
      },
    },
    approve: async ({ runId, approvalId, toolName, input }) => {
      try {
        assertRunAvailable(runId);
      } catch (error) {
        return { decision: "deny", message: String(error) };
      }
      return runService.requestApproval(runId, approvalId, toolName, input);
    },
  };
}
