import { useEffect, useState } from "react";
import { readTeamMoveRequest, teamMoveRequestChanged, teamMoveStorageKey, type TeamMoveRequest } from "./team-move-request";

export function useTeamMoveRequest(threadId: string, enabled = true) {
  const read = (): { request: TeamMoveRequest | null; error: string | null } => {
    if (!enabled) return { request: null, error: null };
    try {
      return { request: readTeamMoveRequest(threadId), error: null };
    } catch (error) {
      return { request: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const [saved, setSaved] = useState(read);
  const refresh = () => setSaved(read());
  useEffect(() => {
    refresh();
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === teamMoveStorageKey(threadId)) refresh();
    };
    const local = (event: Event) => {
      if ((event as CustomEvent<string>).detail === threadId) refresh();
    };
    window.addEventListener("storage", storage);
    window.addEventListener(teamMoveRequestChanged, local);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener(teamMoveRequestChanged, local);
    };
  }, [threadId, enabled]);
  return { ...saved, refresh };
}
