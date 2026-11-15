import type { TaskBoard } from "@openorc/protocol";
import { useQuery } from "@tanstack/react-query";
import { link, queryClient, useLinkState } from "../client";
import { boardSection, type BoardSection } from "./board";

/**
 * The shown Mac's task list, refreshed when it says its tasks changed. Never asked while the phone is not connected; kept
 * across launches. `available` once the Mac answered: one from before task lists answers with an error, so the phone
 * shows no task list for it.
 */
export function useTaskBoard(): { section: BoardSection | null; available: boolean } {
  const state = useLinkState();
  const live = state.kind === "connected";
  const read = useQuery<TaskBoard>({ queryKey: ["tasks.board"], queryFn: () => link.connection.device("tasks.board", {}), meta: { tags: ["tasks"] }, enabled: live, retry: false }, queryClient);
  const mac = state.kind === "unpaired" ? null : { name: state.mac.name, live, board: read.data, heardAt: read.dataUpdatedAt };
  return { section: boardSection(mac), available: Boolean(read.data) };
}
