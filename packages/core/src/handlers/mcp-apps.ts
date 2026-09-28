import { RunService } from "../services/runs.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  runService: Pick<RunService, "mcpApps" | "resolveApproval">;
};

export function createMcpAppsHandlers({ runService }: Dependencies): Pick<Handlers, "mcpApps.open" | "mcpApps.close" | "mcpApps.read" | "mcpApps.call" | "approvals.resolve"> {
  return {
    "mcpApps.open": ({ runId, toolCallId }) => runService.mcpApps.open(runId, toolCallId),
    "mcpApps.close": ({ viewId }) => {
      runService.mcpApps.close(viewId);
      return null;
    },
    "mcpApps.read": ({ viewId, uri }) => runService.mcpApps.readResource(viewId, uri),
    "mcpApps.call": ({ viewId, name, arguments: args }) => runService.mcpApps.callTool(viewId, name, args),
    "approvals.resolve": ({ runId, approvalId, decision, answers }) => {
      runService.resolveApproval(runId, approvalId, decision, answers);
      return null;
    },
  };
}
