import { parse, type ParseError } from "jsonc-parser";

/**
 * OpenOrc's MCP server added to an OpenCode configuration override, with its tools on the model's own list. Passed in
 * `session/new`, OpenCode would put them behind Code Mode's `execute`, where OpenOrc cannot tell which of its tools ran:
 * a visualization would show as a script instead of drawn.
 */
export function ownServerConfig(content: string | undefined, serverName: string, url: string): string {
  const errors: ParseError[] = [];
  const config = content ? parse(content, errors, { allowTrailingComma: true }) : {};
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON/JSONC object to add OpenOrc's tools.");
  const mcp = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp) ? config.mcp : {};
  const server = { type: "remote", url, oauth: false, codemode: false };
  return JSON.stringify({ ...config, mcp: { ...mcp, servers: { ...mcp.servers, [serverName]: server } } });
}
