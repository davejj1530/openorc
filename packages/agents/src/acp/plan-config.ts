import { parse, type ParseError } from "jsonc-parser";
import type { RunSpec } from "@openorc/protocol";

/** Deny is final even in the presence of remembered OpenCode approvals. */
export function planConfig(content: string | undefined, internal: RunSpec["internalMcp"]): string {
  const errors: ParseError[] = [];
  const config = content ? parse(content, errors, { allowTrailingComma: true }) : {};
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid OpenCode configuration; Plan was not started.");
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "websearch", "webfetch", "execute"].map((action) => ({ action, resource: "*", effect: "allow" })),
    { action: "external_directory", resource: "*", effect: "ask" },
    ...(internal?.toolNames ?? []).map((tool) => ({ action: `${internal!.serverName}_${tool}`, resource: "*", effect: "allow" })),
  ];
  return JSON.stringify({ ...config, default_agent: "plan", agents: { ...config.agents, plan: { ...config.agents?.plan, permissions } } });
}
