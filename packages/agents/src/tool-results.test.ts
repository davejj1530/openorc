import { expect, it } from "vitest";
import { AgentEvent } from "@openorc/protocol";
import { mapNotification } from "./codex/notifications.js";
import { ClaudeStreamParser } from "./claude/stream-json.js";

it("preserves mixed MCP content and structured results through Codex normalization and serialization", () => {
  const result = {
    content: [
      { type: "text", text: "Search results" },
      { type: "image", mimeType: "image/webp", data: "UklGRg==" },
    ],
    structuredContent: { screens: [{ id: "screen-1", image_url: "https://example.com/image" }] },
  };
  const events = mapNotification(
    "run",
    "item/completed",
    { item: { type: "mcpToolCall", id: "search", server: "mobbin", tool: "search_screens", arguments: {}, status: "completed", result } },
    { summaryIndex: new Map(), buffering: new Set() },
  );
  const completed = events.find((event) => event.type === "tool.completed");
  expect(AgentEvent.parse(JSON.parse(JSON.stringify(completed)))).toMatchObject({ type: "tool.completed", name: "mobbin.search_screens", output: result });
});

it("preserves Claude base64 image sources alongside text through normalization and serialization", () => {
  const parser = new ClaudeStreamParser("run");
  parser.parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "search", name: "mcp__mobbin__search_screens", input: {} }] } }));
  const content = [
    { type: "text", text: "Search results" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
  ];
  const events = parser.parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "search", content }] } }));
  const completed = events.find((event) => event.type === "tool.completed");
  expect(AgentEvent.parse(JSON.parse(JSON.stringify(completed)))).toMatchObject({ type: "tool.completed", name: "mcp__mobbin__search_screens", output: content });
});
