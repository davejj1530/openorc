export interface TeamForkRequest {
  requestKey: string;
  upToRunId: string | null;
}
export const teamForkStorageKey = (id: string) => `openorc.draft.team.${id}.fork`;
export const teamForkRequestChanged = "openorc:team-fork-request";

function notify(id: string): void {
  // Storage events reach other windows; mounted controls in this window also
  // share the saved request (reply actions and the task menu).
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(teamForkRequestChanged, { detail: id }));
}

export function readTeamForkRequest(id: string): TeamForkRequest | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(teamForkStorageKey(id));
  } catch {
    throw new Error("Could not read the saved fork request. Restore local storage before forking.");
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
      "upToRunId" in value &&
      (value.upToRunId === null || (typeof value.upToRunId === "string" && value.upToRunId.length > 0))
    )
      return { requestKey: value.requestKey, upToRunId: value.upToRunId };
  } catch {
    /* Preserve an unreadable request: it may already have created a fork. */
  }
  throw new Error("The saved fork request could not be read. It is retained to prevent a duplicate fork. Refresh team status to check for recovery.");
}

/** The server's retained operation owns its exact cutoff, even when another window saved a different request. */
export function beginTeamForkRequest(id: string, options: { recovery?: TeamForkRequest; upToRunId?: string | null } = {}, createKey: () => string = () => crypto.randomUUID()): TeamForkRequest {
  const previous = options.recovery ?? readTeamForkRequest(id);
  // Undefined means the task menu can resume any saved cutoff. An explicit
  // reply must never silently fork a different point in the conversation.
  if (previous && options.upToRunId !== undefined && previous.upToRunId !== options.upToRunId)
    throw new Error("A fork from another point needs confirmation first. Use Retry fork in the task menu before choosing another reply.");
  const request = previous ? { requestKey: previous.requestKey, upToRunId: previous.upToRunId } : { requestKey: createKey(), upToRunId: options.upToRunId ?? null };
  try {
    localStorage.setItem(teamForkStorageKey(id), JSON.stringify(request));
  } catch {
    throw new Error("Could not save this fork request for recovery. Restore local storage and retry; no fork was requested.");
  }
  notify(id);
  return request;
}

export function finishTeamForkRequest(id: string, request: TeamForkRequest): boolean {
  try {
    const current = readTeamForkRequest(id);
    // Another window may already have confirmed this reply or begun its next
    // intentional fork. Acknowledge ours without erasing that newer request.
    if (!current || current.requestKey !== request.requestKey || current.upToRunId !== request.upToRunId) return true;
    localStorage.removeItem(teamForkStorageKey(id));
    notify(id);
    return true;
  } catch {
    return false;
  }
}
