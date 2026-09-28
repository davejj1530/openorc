import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserCommand, type BrowserResult } from "@openorc/protocol";

export function registerBrowserTool(mcp: McpServer, execute: (command: BrowserCommand) => Promise<BrowserResult>): void {
  mcp.registerTool(
    "browser",
    {
      description:
        "Control the shared Preview in OpenOrc. open requires url; click requires ref; fill requires ref and text; press requires key; scroll requires y and optional x in CSS pixels. Other actions take no extra fields. Snapshots cover the main document and open shadow roots; screenshots show the viewport. The Preview shares the user's signed-in sessions: depending on the conversation's mode, click, fill and press ask the user first, and Plan mode cannot use them. Typing into a password field always asks the user.",
      inputSchema: z
        .object({
          action: z.enum(["open", "snapshot", "screenshot", "click", "fill", "press", "scroll"]),
          url: z.string().optional(),
          ref: z.string().optional(),
          text: z.string().optional(),
          key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Space"]).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        })
        .strict(),
    },
    async (input) => {
      const { screenshot, ...result } = await execute(BrowserCommand.parse(input));
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }, ...(screenshot ? [{ type: "image" as const, ...screenshot }] : [])] };
    },
  );
}
