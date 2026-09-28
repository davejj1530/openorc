import { expect, it, vi } from "vitest";
import { codexMcpApps } from "./mcp-apps.js";
import { mapNotification, type NotificationState } from "./notifications.js";
import { AgentEvent } from "@openorc/protocol";
it("uses the owning thread's authenticated RPC and follows tool pagination", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: [], nextCursor: "next" })
    .mockResolvedValueOnce({ data: [{ name: "gallery", tools: { search: { name: "search", _meta: { ui: { resourceUri: "ui://gallery" } } } } }], nextCursor: null })
    .mockResolvedValue({});
  const connection = codexMcpApps({ request }, () => "thread-1");
  expect(await connection.listTools("gallery")).toHaveLength(1);
  expect(request).toHaveBeenNthCalledWith(2, "mcpServerStatus/list", { threadId: "thread-1", cursor: "next", limit: 100 });
  await connection.readResource({ server: "gallery", tool: "search", connectorId: "connector" }, "ui://gallery", "call-1");
  expect(request).toHaveBeenLastCalledWith("mcpServer/resource/read", { threadId: "thread-1", server: "gallery", uri: "ui://gallery", originCallId: "call-1", connectorId: "connector" });
  await connection.callTool("gallery", "search", { q: "settings" });
  expect(request).toHaveBeenLastCalledWith("mcpServer/tool/call", { threadId: "thread-1", server: "gallery", tool: "search", arguments: { q: "settings" } }, 0);
});
it("preserves app context first seen on a start through completion and history serialization", () => {
  const state: NotificationState = { summaryIndex: new Map(), buffering: new Set() };
  const item = { id: "call", type: "mcpToolCall", server: "gallery", tool: "search", arguments: {} };
  mapNotification("run", "item/started", { item: { ...item, appContext: { connectorId: "connector", resourceUri: "ui://gallery" } } }, state);
  const events = mapNotification("run", "item/completed", { item: { ...item, status: "completed", result: { content: [] } } }, state);
  expect(AgentEvent.parse(JSON.parse(JSON.stringify(events[0])))).toMatchObject({ mcp: { server: "gallery", tool: "search", connectorId: "connector", resourceUri: "ui://gallery" } });
  expect(state.mcpSources?.size).toBe(0);
});
