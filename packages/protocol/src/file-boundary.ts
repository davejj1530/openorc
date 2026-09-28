/** Where an agent may write: `root` and everything below it. `outside` is Claude Code's answer for any other path. */
export interface FileBoundary {
  root: string;
  /** Resolves relative paths in a request. */
  cwd: string;
  outside: "ask" | "deny";
}

const fields = ["root", "cwd", "outside"] as const;

/** Where OpenOrc's MCP server answers the file-boundary hook, for the run that owns `mcpUrl`. Carries its secret. */
export function fileBoundaryUrl(mcpUrl: string, boundary: FileBoundary): string {
  return `${mcpUrl}/file-boundary?${fields.map((field) => `${field}=${encodeURIComponent(boundary[field])}`).join("&")}`;
}

/** The boundary from a hook address's query, or null when it is incomplete. */
export function parseFileBoundary(query: { get(name: string): string | null }): FileBoundary | null {
  const root = query.get("root");
  const cwd = query.get("cwd");
  const outside = query.get("outside");
  if (!root || !cwd || (outside !== "ask" && outside !== "deny")) return null;
  return { root, cwd, outside };
}
