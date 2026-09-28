import type { McpAppConnection } from "@openorc/protocol";
import type { StdioJsonRpc } from "../jsonrpc.js";

/** Reuses app-server's authentication, connection lifetime and provider policy. */
export function codexMcpApps(rpc: Pick<StdioJsonRpc, "request">, thread: () => string | null): McpAppConnection {
  const threadId = () => {
    const id = thread();
    if (!id) throw new Error("The Codex session is not ready.");
    return id;
  };
  return {
    async listTools(server) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page: { data: { name: string; tools: Record<string, Record<string, unknown>> }[]; nextCursor?: string | null } = await rpc.request("mcpServerStatus/list", {
          threadId: threadId(),
          cursor,
          limit: 100,
        });
        const match = page.data.find((s) => s.name === server);
        if (match) return Object.values(match.tools);
        cursor = page.nextCursor ?? null;
        if (cursor && seen.has(cursor)) throw new Error("MCP tool discovery returned a repeated cursor.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      throw new Error("This MCP server is no longer connected.");
    },
    readResource(source, uri, originCallId) {
      return rpc.request("mcpServer/resource/read", { threadId: threadId(), server: source.server, uri, originCallId, ...(source.connectorId ? { connectorId: source.connectorId } : {}) });
    },
    callTool(server, name, args) {
      // No retry: a lost response cannot prove a tool had no side effects.
      return rpc.request("mcpServer/tool/call", { threadId: threadId(), server, tool: name, arguments: args }, 0);
    },
  };
}
