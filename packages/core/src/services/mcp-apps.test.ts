import { expect, it, vi } from "vitest";
import type { AgentEvent, McpAppConnection } from "@openorc/protocol";
import { McpAppService } from "./mcp-apps.js";

function fixture(metadata: unknown = { ui: { resourceUri: "ui://gallery/index.html" } }) {
  const tool = { name: "search", _meta: metadata, inputSchema: { type: "object" } };
  const call: Extract<AgentEvent, { type: "tool.completed" }> = {
    type: "tool.completed",
    runId: "run",
    ts: 1,
    toolCallId: "call",
    name: "screens.search",
    isError: false,
    mcp: { server: "screens", tool: "search" },
    input: { query: "settings" },
    output: { content: [{ type: "text", text: "Found two screens" }], structuredContent: { screens: [1, 2] }, _meta: { privateForUi: true } },
  };
  const connection: McpAppConnection = {
    listTools: vi.fn(async () => [tool, { name: "hidden", _meta: { ui: { visibility: ["model"] } } }, { name: "paginate", _meta: { ui: { visibility: ["app"] } } }]),
    readResource: vi.fn(async () => ({
      contents: [{ uri: "ui://gallery/index.html", mimeType: "text/html;profile=mcp-app", text: "<h1>Gallery</h1>", _meta: { ui: { csp: { resourceDomains: ["https://example.com"] } } } }],
    })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "Next page" }] })),
  };
  const approve = vi.fn(async (_run: string, _tool: string, _args: unknown, _signal: AbortSignal) => true);
  let live: McpAppConnection | undefined = connection;
  const service = new McpAppService({
    call: (run, id) => (run === "run" && id === "call" ? call : undefined),
    connection: () => live,
    approve,
    remember: (_run, _call, source) => {
      call.mcp = source;
    },
  });
  return {
    service,
    call,
    connection,
    approve,
    disconnect: () => {
      live = undefined;
    },
  };
}
it.each([{ ui: { resourceUri: "ui://gallery/index.html" } }, { "ui/resourceUri": "ui://gallery/index.html" }])("loads standard declarations without interpreting result shapes", async (metadata) => {
  const { service, call, connection } = fixture(metadata);
  const ready = await service.open("run", "call");
  expect(ready).toMatchObject({ status: "ready", input: call.input, result: call.output, html: "<h1>Gallery</h1>", csp: { resourceDomains: ["https://example.com"] } });
  expect(connection.readResource).toHaveBeenCalledWith(call.mcp, "ui://gallery/index.html", "call");
  expect(await service.open("other-run", "call")).toEqual({ status: "none" });
});
it("binds tool calls to the origin server and enforces app visibility and approval", async () => {
  const { service, connection, approve } = fixture();
  const app = await service.open("run", "call");
  if (app.status !== "ready") throw new Error("Missing app");
  await expect(service.callTool(app.viewId, "other-server.delete", {})).rejects.toThrow("not available");
  await expect(service.callTool(app.viewId, "hidden", {})).rejects.toThrow("not available");
  approve.mockResolvedValueOnce(false);
  await expect(service.callTool(app.viewId, "paginate", {})).rejects.toThrow("not approved");
  expect(connection.callTool).not.toHaveBeenCalled();
  await service.callTool(app.viewId, "paginate", { page: 2 });
  expect(approve).toHaveBeenLastCalledWith("run", "screens.paginate", { page: 2 }, expect.any(AbortSignal));
  expect(connection.callTool).toHaveBeenCalledWith("screens", "paginate", { page: 2 });
});
it("revokes pending actions on close and prevents overlapping actions", async () => {
  const { service, connection, approve } = fixture();
  let accept!: (value: boolean) => void;
  approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const app = await service.open("run", "call");
  if (app.status !== "ready") throw new Error("Missing app");
  const pending = service.callTool(app.viewId, "paginate", {});
  await expect(service.callTool(app.viewId, "paginate", {})).rejects.toThrow("already pending");
  service.close(app.viewId);
  expect(approve.mock.calls[0]![3].aborted).toBe(true);
  accept(true);
  await expect(pending).rejects.toThrow("no longer available");
  expect(connection.callTool).not.toHaveBeenCalled();
});
it("shows saved-session fallback and rejects stale views", async () => {
  const { service, disconnect } = fixture();
  const app = await service.open("run", "call");
  if (app.status !== "ready") throw new Error("Missing app");
  disconnect();
  await expect(service.readResource(app.viewId, "resource://anything")).rejects.toThrow("no longer available");
  expect(await service.open("run", "call")).toMatchObject({ status: "unavailable" });
});
it("restricts shared-server apps to their own connector", async () => {
  const { service, call, connection } = fixture();
  call.mcp!.connectorId = "weather";
  vi.mocked(connection.listTools).mockResolvedValue([
    { name: "search", inputSchema: { type: "object" }, _meta: { connector_id: "weather", ui: { resourceUri: "ui://gallery/index.html" } } },
    { name: "other.delete", _meta: { connector_id: "another" } },
  ]);
  const app = await service.open("run", "call");
  if (app.status !== "ready") throw new Error("Missing app");
  await expect(service.callTool(app.viewId, "other.delete", {})).rejects.toThrow("not available");
  expect(connection.callTool).not.toHaveBeenCalled();
});
it("does not execute HTML without an explicit app declaration and MIME type", async () => {
  const noApp = fixture({});
  expect(await noApp.service.open("run", "call")).toEqual({ status: "none" });
  expect(noApp.connection.readResource).not.toHaveBeenCalled();
  const invalid = fixture();
  vi.mocked(invalid.connection.readResource).mockResolvedValue({ contents: [{ uri: "ui://gallery/index.html", mimeType: "text/html", text: "<script>evil</script>" }] });
  expect(await invalid.service.open("run", "call")).toMatchObject({ status: "unavailable", message: expect.stringContaining("MCP App document") });
});
