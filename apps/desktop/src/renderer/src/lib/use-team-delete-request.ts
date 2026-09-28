import { useEffect, useState } from "react";
import { readTeamDeleteRequest, teamDeleteRequestChanged, teamDeleteStorageKey, type TeamDeleteRequest } from "./team-delete-request";

export function useTeamDeleteRequest(threadId: string, enabled = true) {
  const read = (): { request: TeamDeleteRequest | null; error: string | null } => {
    if (!enabled) return { request: null, error: null };
    try {
      return { request: readTeamDeleteRequest(threadId), error: null };
    } catch (error) {
      return { request: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const [saved, setSaved] = useState(read);
  const refresh = () => setSaved(read());
  useEffect(() => {
    refresh();
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === teamDeleteStorageKey(threadId)) refresh();
    };
    const local = (event: Event) => {
      if ((event as CustomEvent<string>).detail === threadId) refresh();
    };
    window.addEventListener("storage", storage);
    window.addEventListener(teamDeleteRequestChanged, local);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener(teamDeleteRequestChanged, local);
    };
  }, [threadId, enabled]);
  return { ...saved, refresh };
}
