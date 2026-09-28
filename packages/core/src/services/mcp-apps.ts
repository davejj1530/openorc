import { randomUUID } from "node:crypto";
import { McpAppDocument, type AgentEvent, type McpAppConnection, type McpAppOpenResult, type McpToolSource } from "@openorc/protocol";

type ToolCall = Extract<AgentEvent, { type: "tool.completed" }>;
interface View {
  runId: string;
  callId: string;
  source: McpToolSource;
  connection: McpAppConnection;
  tools: Record<string, unknown>[];
  controller: AbortController;
  busy: boolean;
}
export interface McpAppHost {
  call(runId: string, callId: string): ToolCall | undefined;
  connection(runId: string): McpAppConnection | undefined;
  approve(runId: string, tool: string, args: unknown, signal: AbortSignal): Promise<boolean>;
  remember?(runId: string, callId: string, source: McpToolSource): void;
}

/** Owns server scoping and revocable views. No renderer-supplied server, URI or tool metadata is trusted. */
export class McpAppService {
  private readonly views = new Map<string, View>();
  constructor(private readonly host: McpAppHost) {}

  async open(runId: string, callId: string): Promise<McpAppOpenResult> {
    const call = this.host.call(runId, callId);
    if (!call?.mcp) return { status: "none" };
    const connection = this.host.connection(runId);
    if (!connection)
      return call.mcp.resourceUri ? { status: "unavailable", message: "Interactive apps need a live, supported provider session. The saved result is still available." } : { status: "none" };
    try {
      // Aggregators can host multiple connectors under one MCP server.
      const tools = (await connection.listTools(call.mcp.server)).filter((t) => !call.mcp!.connectorId || object(t._meta).connector_id === call.mcp!.connectorId);
      const tool = tools.find((t) => t.name === call.mcp!.tool);
      const meta = object(tool?._meta);
      const uri = call.mcp.resourceUri ?? object(meta.ui).resourceUri ?? meta["ui/resourceUri"];
      if (typeof uri !== "string") return { status: "none" };
      if (!uri.startsWith("ui://")) throw new Error("The server declared an invalid app resource.");
      if (uri !== call.mcp.resourceUri) this.host.remember?.(runId, callId, { ...call.mcp, resourceUri: uri });
      const result = object(await connection.readResource(call.mcp, uri, callId));
      const contents = Array.isArray(result.contents) ? result.contents.map(object) : [];
      const resource = contents.find((r) => r.uri === uri && typeof r.mimeType === "string" && /^text\/html\s*;\s*profile=mcp-app$/i.test(r.mimeType));
      if (!resource) throw new Error("The server did not return an MCP App document.");
      if (typeof resource.blob === "string" && resource.blob.length > 7 * 1024 * 1024) throw new Error("This app document is too large.");
      const html = resourceHtml(resource);
      const document = McpAppDocument.parse({ html, csp: object(object(resource._meta).ui).csp ?? {} });
      if (this.host.connection(runId) !== connection) throw new Error("The provider session ended while loading this app.");
      if (this.views.size >= 64) throw new Error("Close another interactive app before opening this one.");
      const viewId = randomUUID();
      this.views.set(viewId, { runId, callId, source: call.mcp, connection, tools, controller: new AbortController(), busy: false });
      return {
        status: "ready",
        viewId,
        title: typeof tool?.title === "string" ? tool.title : call.mcp.tool,
        ...document,
        tool: tool ?? { name: call.mcp.tool, inputSchema: { type: "object" } },
        input: object(call.input),
        result: object(call.output),
      };
    } catch (error) {
      return { status: "unavailable", message: error instanceof Error ? error.message : "This interactive app could not be loaded." };
    }
  }

  close(viewId: string): void {
    this.views.get(viewId)?.controller.abort();
    this.views.delete(viewId);
  }
  closeRun(runId: string): void {
    for (const [id, view] of this.views) if (view.runId === runId) this.close(id);
  }
  private view(id: string): View {
    const view = this.views.get(id);
    if (!view || this.host.connection(view.runId) !== view.connection) {
      this.close(id);
      throw new Error("This app's provider session is no longer available. Reopen it from a live session.");
    }
    return view;
  }
  async readResource(id: string, uri: string): Promise<unknown> {
    const view = this.view(id);
    return view.connection.readResource(view.source, uri, view.callId);
  }
  async callTool(id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const view = this.view(id);
    if (!view.tools.some((t) => t.name === name && appVisible(t))) throw new Error("This tool is not available to this app.");
    if (view.busy) throw new Error("An app action is already pending. Wait for it to finish.");
    view.busy = true;
    try {
      if (!(await this.host.approve(view.runId, `${view.source.server}.${name}`, args, view.controller.signal))) throw new Error("This app action was not approved.");
      this.view(id); // Closing the view or tightening permissions cannot race an approval.
      return await view.connection.callTool(view.source.server, name, args);
    } finally {
      view.busy = false;
    }
  }
}
function appVisible(tool: Record<string, unknown>): boolean {
  const visibility = object(object(tool._meta).ui).visibility;
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes("app"));
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function resourceHtml(resource: Record<string, unknown>): string | undefined {
  if (typeof resource.text === "string") return resource.text;
  if (typeof resource.blob === "string") return Buffer.from(resource.blob, "base64").toString("utf8");
  return undefined;
}
