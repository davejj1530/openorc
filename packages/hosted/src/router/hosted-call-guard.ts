import type { HostedThreads } from "../index.js";
import { HOSTED_REASONS, hostedThreadOf, ownerRoute, type RpcMethod } from "@openorc/protocol";

function threadOf(method: RpcMethod, params: Record<string, unknown>): string | null {
  const scope = params["scope"];
  if (scope && typeof scope === "object" && "kind" in scope && scope.kind === "thread" && "id" in scope && typeof scope.id === "string") return scope.id;
  const route = ownerRoute(method);
  if (!route) return null;
  const id = params["threadId"] ?? (method.startsWith("threads.") ? params["id"] : undefined);
  return typeof id === "string" ? id : null;
}

/**
 * Ownership outlives access. A withdrawn cloud id must never become a request against this Mac, unless the thread came
 * to this Mac by a move, keeping its id (`movedHere`): then the id is this Mac's own.
 */
export class HostedCallGuard {
  private readonly known = new Set<string>();
  constructor(private readonly movedHere: (threadId: string) => boolean = () => false) {}

  refusal(place: HostedThreads | null, method: RpcMethod, params: Record<string, unknown>): string | null {
    const held = this.check(place, method, params);
    if (held === "unavailable") return "That conversation isn't available on OpenOrc Cloud.";
    return held === "held" && !ownerRoute(method) ? HOSTED_REASONS.fileBrowser : null;
  }

  private check(place: HostedThreads | null, method: RpcMethod, params: Record<string, unknown>): "held" | "unavailable" | null {
    const run = typeof params["runId"] === "string" ? hostedThreadOf(params["runId"]) : null;
    const id = run ?? threadOf(method, params);
    if (!id) return null;
    if (place?.active && place.holds({ thread: id })) {
      this.known.add(id);
      return "held";
    }
    if (run) return "unavailable";
    if (!this.known.has(id)) return null;
    if (!this.movedHere(id)) return "unavailable";
    this.known.delete(id);
    return null;
  }
}

/**
 * This Mac's own answers about a cloud thread: its work brought into the folder its project came from (core's
 * macProjects), and the thread itself moved here (core's CloudMoves). They read the thread on the server and write only this Mac's folder, so they are never the place's.
 */
const FOR_THIS_MAC: ReadonlySet<RpcMethod> = new Set(["macProjects.bringState", "macProjects.bring", "threads.moveCheck", "threads.move", "threads.moveDismiss", "threads.cloudCopy"]);

/** A here-routed operation still cannot substitute this Mac's files for a hosted conversation. */
export function heldHereCall(place: HostedThreads, method: RpcMethod, params: Record<string, unknown>): boolean {
  if (FOR_THIS_MAC.has(method)) return false;
  const threadId = params["threadId"] ?? (method.startsWith("threads.") ? params["id"] : undefined);
  if (typeof threadId === "string" && place.holds({ thread: threadId })) return true;
  const runId = params["runId"];
  return typeof runId === "string" && place.holds({ run: runId });
}
