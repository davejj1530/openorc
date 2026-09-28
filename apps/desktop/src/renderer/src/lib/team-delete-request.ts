export interface TeamDeleteRequest {
  requestKey: string;
}
export interface TeamDeleteRecovery {
  requestKey: string;
  error: string | null;
}
export const teamDeleteStorageKey = (id: string) => `openorc.draft.team.${id}.delete`;
export const teamDeleteRequestChanged = "openorc:team-delete-request";

function notify(id: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(teamDeleteRequestChanged, { detail: id }));
}

export function readTeamDeleteRequest(id: string): TeamDeleteRequest | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(teamDeleteStorageKey(id));
  } catch {
    throw new Error("Could not read the saved delete request. Restore local storage before deleting this conversation.");
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "requestKey" in value && typeof value.requestKey === "string" && value.requestKey.trim() && value.requestKey.length <= 200)
      return { requestKey: value.requestKey };
  } catch {
    /* An unreadable delete may already have removed files. Keep it. */
  }
  throw new Error("The saved delete request could not be read. It is retained to prevent a repeated deletion. Refresh team status to check for recovery.");
}

/** The server's retained request is authoritative; a local key only covers a lost reply. */
export function beginTeamDeleteRequest(id: string, recovery?: TeamDeleteRecovery, createKey: () => string = () => crypto.randomUUID()): TeamDeleteRequest {
  let local: TeamDeleteRequest | null;
  try {
    local = readTeamDeleteRequest(id);
  } catch (error) {
    if (!recovery) throw error;
    local = null;
  }
  const request = recovery ? { requestKey: recovery.requestKey } : (local ?? { requestKey: createKey() });
  try {
    localStorage.setItem(teamDeleteStorageKey(id), JSON.stringify(request));
  } catch {
    throw new Error("Could not save this delete request for recovery. Restore local storage and retry; nothing was deleted.");
  }
  notify(id);
  return request;
}

export function finishTeamDeleteRequest(id: string, request: TeamDeleteRequest): boolean {
  try {
    const current = readTeamDeleteRequest(id);
    if (!current || current.requestKey !== request.requestKey) return true;
    localStorage.removeItem(teamDeleteStorageKey(id));
    notify(id);
    return true;
  } catch {
    return false;
  }
}
