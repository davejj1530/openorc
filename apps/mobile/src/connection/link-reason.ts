import type { LinkState } from "./manager";

/**
 * Why nothing can be asked of the Mac while the phone has no session with it. A first connect on its way may still
 * carry a request; a retry after trouble is not counted on.
 */
export function linkReason(state: LinkState): string | null {
  if (state.kind === "connected" || state.kind === "unpaired") return null;
  if (state.kind === "connecting" && state.why === null) return null;
  return `Not connected to ${state.mac.name}`;
}
