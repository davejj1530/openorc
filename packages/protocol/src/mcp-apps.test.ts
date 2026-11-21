import { expect, it } from "vitest";
import { bareToolName } from "./mcp-apps.js";
import { isVisualizationTool } from "./visualization.js";

const server = "0123456789abcdef".repeat(2);

it.each([
  ["Read", "Read"],
  ["mcp__claude_ai_Slack__send_message", "send_message"],
  ["openorc.task_suggest", "task_suggest"],
  [`mcp__openorc_${server}__task_suggest`, "task_suggest"],
  [`openorc_${server}.task_suggest`, "task_suggest"],
  [`openorc_${server}_task_suggest`, "task_suggest"],
])("names %s by its own name, %s, as Claude Code, Codex and OpenCode report it", (name, bare) => {
  expect(bareToolName(name)).toBe(bare);
});

it("recognises OpenOrc's visualize tool only on OpenOrc's server", () => {
  expect(isVisualizationTool(`openorc_${server}_visualize`)).toBe(true);
  expect(isVisualizationTool("mcp__untrusted__visualize")).toBe(false);
  expect(isVisualizationTool("visualize")).toBe(false);
});
