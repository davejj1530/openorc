import type { RunSpec } from "@openorc/protocol";

/** A per-process Pi extension. Credentials and user configuration remain in Pi's own home. */
export function piBridge(spec: RunSpec, nonce: string): string {
  const config = { internal: spec.internalMcp, mode: spec.mode ?? "act", permission: spec.permissionMode, nonce };
  return `export default function (pi) {
  const config = ${JSON.stringify(config)};
  const readTools = new Set(["read", "grep", "find", "ls"]);
  if (config.internal) pi.registerMcpServer(config.internal.serverName, { url: config.internal.url, exposure: "direct" });
  pi.on("session_start", (_event, ctx) => ctx.ui.notify("openorc-ready:" + config.nonce));
  pi.on("tool_call", async (event, ctx) => {
    const internal = config.internal?.toolNames.some(name => event.toolName === "mcp__" + config.internal.serverName + "__" + name);
    if (internal || readTools.has(event.toolName)) return;
    if (config.mode === "plan") return { block: true, reason: "Plan mode is read-only. Use OpenOrc's plan_write tool to propose changes." };
    if (config.permission === "trusted" && (event.toolName === "edit" || event.toolName === "write")) return;
    const allowed = await ctx.ui.confirm("openorc-tool:" + config.nonce, JSON.stringify({ toolName: event.toolName, input: event.input, toolCallId: event.toolCallId }));
    if (!allowed) return { block: true, reason: "OpenOrc declined this tool call." };
  });
}`;
}
