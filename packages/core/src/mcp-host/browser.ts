import { Db, runs, tasks, teamDeletedThreads, threads } from "@openorc/db";
import { type McpHost } from "@openorc/mcp";
import type { BrowserCommand, BrowserHost } from "@openorc/protocol";
import { RunService } from "../services/runs.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  db: Db;
  runService: Pick<RunService, "isBusy" | "authorizeAppAction">;
  browser?: BrowserHost;
  assertTeamActor: RunContext["assertTeamActor"];
};
export function createBrowserHost({ db, runService, browser, assertTeamActor }: Dependencies): Pick<McpHost, "browser"> {
  return browser
    ? ({
        browser: async (runId, command) => {
          assertTeamActor(runId);
          const surface = browserSurface(db, runService, runId);
          if (command.action === "click" || command.action === "fill" || command.action === "press")
            await runService.authorizeAppAction(runId, "browser_input", { toolName: `browser ${command.action}`, reason: browserInputReason(command), input: command });
          const result = await browser(surface, command);
          if (result.refused !== "password" || command.action !== "fill") return result;
          await runService.authorizeAppAction(runId, "secret_input", {
            toolName: "browser fill password",
            reason: `Type the agent's text into a password field on ${new URL(result.url).host}.`,
            input: { url: result.url },
          });
          return browser(surface, { ...command, secret: true });
        },
      } satisfies Pick<McpHost, "browser">)
    : {};
}
function browserInputReason(command: Extract<BrowserCommand, { action: "click" | "fill" | "press" }>): string {
  if (command.action === "click") return "Click an element in the Preview, which shares your signed-in sessions.";
  if (command.action === "press") return `Press ${command.key} in the Preview, which shares your signed-in sessions.`;
  return "Type into a field in the Preview, which shares your signed-in sessions.";
}

function browserSurface(db: Db, runService: Pick<RunService, "isBusy">, runId: string): `thread:${string}` | `task:${string}` {
  const run = runs.get(db, runId);
  if (!run || run.commentTurnId || !runService.isBusy(runId)) throw new Error("Browser access requires an active conversation turn.");
  const task = run.taskId ? tasks.get(db, run.taskId) : null;
  const threadId = run.threadId ?? task?.threadId;
  if (threadId && (!threads.get(db, threadId) || teamDeletedThreads.has(db, threadId))) throw new Error("The browser's conversation no longer exists.");
  if (threadId) return `thread:${threadId}`;
  if (task) return `task:${task.id}`;
  throw new Error("This run has no conversation preview.");
}
