import type { HostedThreads } from "@openorc/hosted";
import type { RpcMethod } from "@openorc/protocol";

/** A here-routed operation still cannot substitute this Mac's files for a hosted conversation. */
export function heldHereCall(place: HostedThreads, method: RpcMethod, params: Record<string, unknown>): boolean {
  const threadId = params["threadId"] ?? (method.startsWith("threads.") ? params["id"] : undefined);
  if (typeof threadId === "string" && place.holds({ thread: threadId })) return true;
  const runId = params["runId"];
  return typeof runId === "string" && place.holds({ run: runId });
}
