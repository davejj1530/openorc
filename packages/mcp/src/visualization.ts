import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Visualization, visualizationInstructions } from "@openorc/protocol";

export function registerVisualizationTool(mcp: McpServer): void {
  mcp.registerTool(
    "visualize",
    {
      title: "Visualize a concept",
      description: visualizationInstructions,
      inputSchema: Visualization,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, description }) => ({
      // The original input is already saved in the transcript. Do not echo the HTML into model context.
      content: [{ type: "text", text: JSON.stringify({ title, description, message: "Visualization added to the conversation." }) }],
    }),
  );
}
