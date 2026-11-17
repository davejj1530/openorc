import { HOSTED_REASONS, hostedThreadOf, type McpAppOpenResult, type RpcParams } from "@openorc/protocol";
import { capabilities } from "./capabilities.js";
import { Refused } from "./session.js";
import type { Threads } from "./threads.js";
import { ROUTES } from "./wire.js";

/**
 * A cloud thread's interactive MCP apps (the app's mcpApps.*), answered by the server where its agent's process runs:
 * a view is its run's, so every call names the run. A server that doesn't serve them says so in its words.
 */
async function served(threads: Threads, runId: string): Promise<string> {
  const threadId = hostedThreadOf(runId);
  if (threadId === null) throw new Refused(HOSTED_REASONS.interactiveApp);
  const feature = (await capabilities(threads, { threadId })).features.interactiveApp;
  if (!feature?.available) throw new Refused(feature?.reason ?? HOSTED_REASONS.interactiveApp);
  return threadId;
}

export async function openApp(threads: Threads, { runId, toolCallId }: RpcParams<"mcpApps.open">): Promise<McpAppOpenResult> {
  const threadId = await served(threads, runId);
  return threads.on(threadId).request(ROUTES.mcpAppOpen(threadId), { toolCallId }) as Promise<McpAppOpenResult>;
}

export async function readApp(threads: Threads, { runId, viewId, uri }: RpcParams<"mcpApps.read">): Promise<unknown> {
  const threadId = await served(threads, runId);
  return threads.on(threadId).request(ROUTES.mcpAppRead(threadId, viewId), { uri });
}

export async function callApp(threads: Threads, { runId, viewId, name, arguments: args }: RpcParams<"mcpApps.call">): Promise<unknown> {
  const threadId = await served(threads, runId);
  return threads.on(threadId).request(ROUTES.mcpAppCall(threadId, viewId), { name, arguments: args });
}

export async function closeApp(threads: Threads, { runId, viewId }: RpcParams<"mcpApps.close">): Promise<null> {
  const threadId = hostedThreadOf(runId);
  if (threadId === null) return null;
  await threads
    .on(threadId)
    .request(ROUTES.mcpAppClose(threadId, viewId))
    .catch(() => undefined);
  return null;
}
