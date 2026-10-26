import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceToolInput, type DeviceToolResult } from "@openorc/protocol";

export function registerDeviceTool(mcp: McpServer, execute: (input: DeviceToolInput) => Promise<DeviceToolResult>): void {
  mcp.registerTool(
    "device",
    {
      description:
        "Use the iOS Simulators and Android Emulators in OpenOrc's Device panel. list shows devices; open boots one, shows it to the user and returns the agent-device command for taps and typing; screenshot returns the screen; close removes it from the panel.",
      inputSchema: DeviceToolInput,
    },
    async (input) => {
      const result = await execute(DeviceToolInput.parse(input));
      if (result.action !== "screenshot") return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      const { screenshot, ...rest } = result;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(rest) },
          { type: "image" as const, ...screenshot },
        ],
      };
    },
  );
}
