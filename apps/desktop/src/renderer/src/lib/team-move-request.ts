import type { WorkspaceMode } from "@openorc/protocol";

export interface TeamMoveRequest {
  requestKey: string;
  to: WorkspaceMode;
  phase: "move" | "cancel";
}
export interface TeamMoveRecovery {
  requestKey: string;
  to: WorkspaceMode;
  cancelRequested: boolean;
}
export const teamMoveStorageKey = (id: string) => `openorc.draft.team.${id}.move`;
export const teamMoveRequestChanged = "openorc:team-move-request";

function notify(id: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(teamMoveRequestChanged, { detail: id }));
}

export function readTeamMoveRequest(id: string): TeamMoveRequest | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(teamMoveStorageKey(id));
  } catch {
    throw new Error("Could not read the saved move request. Restore local storage before moving this team.");
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "requestKey" in value &&
      typeof value.requestKey === "string" &&
      value.requestKey.trim() &&
      value.requestKey.length <= 200 &&
      "to" in value &&
      (value.to === "current" || value.to === "worktree") &&
      "phase" in value &&
      (value.phase === "move" || value.phase === "cancel")
    )
      return { requestKey: value.requestKey, to: value.to, phase: value.phase };
  } catch {
    /* An unreadable move may already have written files. Keep it. */
  }
  throw new Error("The saved move request could not be read. It is retained to protect the workspace. Refresh team status to check for recovery.");
}

/** A local cancel intention survives a stale server report of the same receipt. */
export function pendingTeamMove(local: TeamMoveRequest | null, recovery?: TeamMoveRecovery): TeamMoveRequest | null {
  if (!recovery) return local;
  return {
    requestKey: recovery.requestKey,
    to: recovery.to,
    phase: recovery.cancelRequested || (local?.requestKey === recovery.requestKey && local.to === recovery.to && local.phase === "cancel") ? "cancel" : "move",
  };
}

function save(id: string, request: TeamMoveRequest): TeamMoveRequest {
  try {
    localStorage.setItem(teamMoveStorageKey(id), JSON.stringify(request));
  } catch {
    throw new Error("Could not save this workspace request for recovery. Restore local storage and retry; no request was sent.");
  }
  notify(id);
  return request;
}

export function beginTeamMoveRequest(id: string, to: WorkspaceMode, recovery?: TeamMoveRecovery, createKey: () => string = () => crypto.randomUUID()): TeamMoveRequest {
  // Authoritative recovery can replace malformed local state, but a valid
  // cancellation intention for that same receipt must never become a move.
  let local: TeamMoveRequest | null;
  try {
    local = readTeamMoveRequest(id);
  } catch (error) {
    if (!recovery) throw error;
    local = null;
  }
  const pending = pendingTeamMove(local, recovery);
  if (pending?.phase === "cancel") throw new Error("This move has a saved cancellation request. Retry cancellation to confirm its outcome.");
  if (pending && !recovery && pending.to !== to) throw new Error("A move to another destination needs confirmation first. Retry the saved move before choosing another destination.");
  return save(id, pending ?? { requestKey: createKey(), to, phase: "move" });
}

export function beginTeamMoveCancellation(id: string, recovery?: TeamMoveRecovery): TeamMoveRequest {
  let local: TeamMoveRequest | null;
  try {
    local = readTeamMoveRequest(id);
  } catch (error) {
    if (!recovery) throw error;
    local = null;
  }
  const pending = pendingTeamMove(local, recovery);
  if (!pending || (!recovery && pending.phase !== "cancel")) throw new Error("Confirm the saved move before cancelling. The server has not confirmed that it accepted this request.");
  return save(id, { ...pending, phase: "cancel" });
}

export function finishTeamMoveRequest(id: string, request: TeamMoveRequest): boolean {
  try {
    const current = readTeamMoveRequest(id);
    // An acknowledgement for move must not erase a later cancel intention.
    if (!current || current.requestKey !== request.requestKey || current.to !== request.to || current.phase !== request.phase) return true;
    localStorage.removeItem(teamMoveStorageKey(id));
    notify(id);
    return true;
  } catch {
    return false;
  }
}
