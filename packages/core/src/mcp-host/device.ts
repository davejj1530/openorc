import type { Db } from "@openorc/db";
import type { McpHost } from "@openorc/mcp";
import type { DeviceService } from "../devices/service.js";
import type { RunService } from "../services/runs.js";
import type { RunContext } from "./context.js";
import { conversationSurface } from "./surface.js";

type Dependencies = {
  db: Db;
  runService: Pick<RunService, "isBusy" | "authorizeAppAction">;
  devices: Pick<DeviceService, "assertAgentAccess" | "runAgentTool">;
  assertTeamActor: RunContext["assertTeamActor"];
};

/** Opening and closing put a device in front of the user and drive it, so the conversation's mode decides; looking does not. */
export function createDeviceHost({ db, runService, devices, assertTeamActor }: Dependencies): Pick<McpHost, "device"> {
  return {
    device: async (runId, input) => {
      assertTeamActor(runId);
      const surface = conversationSurface(db, runService, runId, "Device");
      devices.assertAgentAccess();
      if (input.action === "open" || input.action === "close") {
        await runService.authorizeAppAction(runId, "device_control", {
          toolName: `device ${input.action}`,
          reason: input.action === "open" ? "Open a simulator or emulator in the Device panel for the agent to drive." : "Close a device in the Device panel.",
          input,
        });
      }
      return devices.runAgentTool(surface, input);
    },
  };
}
