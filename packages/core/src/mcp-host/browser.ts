import type { Db } from "@openorc/db";
import { type McpHost } from "@openorc/mcp";
import type { BrowserCommand, BrowserHost } from "@openorc/protocol";
import { RunService } from "../services/runs.js";
import type { RunContext } from "./context.js";
import { conversationSurface } from "./surface.js";
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
          const surface = conversationSurface(db, runService, runId, "Browser");
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
