export interface TeamRestoreRequest {
  requestKey: string;
  checkpointId: string;
}
export const teamRestoreStorageKey = (id: string) => `openorc.draft.team.${id}.restore`;

export function readTeamRestoreRequest(id: string): TeamRestoreRequest | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(teamRestoreStorageKey(id));
  } catch {
    throw new Error("Could not read the saved restore request. Restore local storage before restoring a checkpoint.");
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
      "checkpointId" in value &&
      typeof value.checkpointId === "string" &&
      value.checkpointId.trim()
    )
      return { requestKey: value.requestKey, checkpointId: value.checkpointId };
  } catch {
    /* Never discard a request which may have changed the active workspace. */
  }
  throw new Error("The saved restore request could not be read. It is retained to prevent a duplicate restore. Refresh team status to check for recovery.");
}

export function beginTeamRestoreRequest(id: string, checkpointId: string, recovery?: TeamRestoreRequest, createKey: () => string = () => crypto.randomUUID()): TeamRestoreRequest {
  const previous = recovery ?? readTeamRestoreRequest(id);
  if (!recovery && previous && previous.checkpointId !== checkpointId)
    throw new Error("A restore request for another checkpoint needs confirmation first. Retry that saved request before choosing another checkpoint.");
  const request = previous ? { requestKey: previous.requestKey, checkpointId: previous.checkpointId } : { requestKey: createKey(), checkpointId };
  try {
    localStorage.setItem(teamRestoreStorageKey(id), JSON.stringify(request));
  } catch {
    throw new Error("Could not save this restore request for recovery. Restore local storage and retry; no restore was requested.");
  }
  return request;
}

export function finishTeamRestoreRequest(id: string, request: TeamRestoreRequest): boolean {
  try {
    const current = readTeamRestoreRequest(id);
    if (!current || current.requestKey !== request.requestKey || current.checkpointId !== request.checkpointId) return true;
    localStorage.removeItem(teamRestoreStorageKey(id));
    return true;
  } catch {
    return false;
  }
}
