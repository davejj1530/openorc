import type { TaskBoard } from "@openorc/protocol";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { hostClient, hostLink, useHostGroup, usePartnerLinkState, useSavedMacs } from "../client";
import { boardSections, type BoardHost, type BoardSection } from "./board";

/** One host's task list, refreshed when it says its tasks changed. Never asked of a host that is not connected; kept across launches. */
function useBoard(host: string | null, connected: boolean) {
  return useQuery<TaskBoard>(
    { queryKey: ["tasks.board"], queryFn: () => hostLink(host).connection.device("tasks.board", {}), meta: { tags: ["tasks"] }, enabled: connected, retry: false },
    hostClient(host).queryClient,
  );
}

/**
 * The task list from the shown host and its partner. `available` once either answered: hosts from before task lists
 * answer with an error, so the phone shows no task list for them.
 */
export function useTaskBoard(): { sections: BoardSection[]; available: boolean } {
  const shown = hostLink(null);
  const shownState = useSyncExternalStore(shown.subscribe, shown.getState);
  const partnerState = usePartnerLinkState();
  const { primary, partner } = useHostGroup();
  const saved = useSavedMacs();
  const shownLive = shownState.kind === "connected";
  const partnerLive = partner !== null && partnerState.kind === "connected";
  const shownBoard = useBoard(null, shownLive);
  const partnerBoard = useBoard(partner, partnerLive);
  const host = (id: string | null, scope: string | null, live: boolean, read: typeof shownBoard): BoardHost | null => {
    const found = saved.find((each) => each.id === id);
    return found ? { host: scope, kind: found.kind ?? "mac", name: found.name, live, board: read.data, heardAt: read.dataUpdatedAt } : null;
  };
  const hosts = [host(primary, null, shownLive, shownBoard), host(partner, partner, partnerLive, partnerBoard)].filter((each) => each !== null);
  return { sections: boardSections(hosts), available: Boolean(shownBoard.data ?? partnerBoard.data) };
}
