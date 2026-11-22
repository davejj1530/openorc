import { z } from "zod";

/** Provider-supplied identity, kept separately from untrusted result JSON. */
export const McpToolSource = z.object({
  server: z.string(),
  tool: z.string(),
  resourceUri: z.string().optional(),
  connectorId: z.string().optional(),
});
export type McpToolSource = z.infer<typeof McpToolSource>;

/** OpenOrc's MCP server before its tools' names: Claude Code's `mcp__openorc_<id>__`, Codex's `openorc_<id>.`, OpenCode's `openorc_<id>_`. */
const OPENORC_TOOL_PREFIX = /^(?:mcp__openorc(?:_[0-9a-f]{32})?__|openorc(?:_[0-9a-f]{32})?\.|openorc_[0-9a-f]{32}_)/;

/** One of OpenOrc's own tools by its own name, or null for another server's tool or an agent's built-in. */
export const openOrcToolName = (name: string): string | null => (OPENORC_TOOL_PREFIX.test(name) ? name.replace(OPENORC_TOOL_PREFIX, "") : null);

/** A tool's own name, without the server an agent puts before an MCP tool's. */
export const bareToolName = (name: string): string => openOrcToolName(name) ?? name.replace(/^mcp__.*?__/, "");

export const McpAppCsp = z.object({
  connectDomains: z.array(z.string()).max(64).optional(),
  resourceDomains: z.array(z.string()).max(64).optional(),
  frameDomains: z.array(z.string()).max(64).optional(),
  baseUriDomains: z.array(z.string()).max(64).optional(),
});
export type McpAppCsp = z.infer<typeof McpAppCsp>;
export const McpAppDocument = z.object({ html: z.string().max(5 * 1024 * 1024), csp: McpAppCsp });
export type McpAppDocument = z.infer<typeof McpAppDocument>;

export interface McpAppReady extends McpAppDocument {
  status: "ready";
  viewId: string;
  title: string;
  tool: Record<string, unknown>;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}
export type McpAppOpenResult = McpAppReady | { status: "none" } | { status: "unavailable"; message: string };

/** Small authenticated provider seam. The core, never the iframe, selects the server. */
export interface McpAppConnection {
  listTools(server: string): Promise<Record<string, unknown>[]>;
  readResource(source: McpToolSource, uri: string, originCallId: string): Promise<unknown>;
  callTool(server: string, name: string, args: Record<string, unknown>): Promise<unknown>;
}
