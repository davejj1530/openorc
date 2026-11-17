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

/**
 * Why a thread cannot be written to for want of the Mac: `linkReason`, unless the thread is OpenOrc Cloud's and the
 * phone reaches the cloud itself (`ownCloud`), which needs no Mac at all.
 */
export function threadLinkReason(state: LinkState, thread: { owner?: { brain?: string } | null } | null, ownCloud: boolean): string | null {
  return ownCloud && thread?.owner?.brain === "hosted" ? null : linkReason(state);
}
