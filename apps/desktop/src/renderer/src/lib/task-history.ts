import { useInfiniteQuery } from "@tanstack/react-query";
import { onlineTaskKey, onlineTaskTags } from "@openorc/client";
import type { OnlineTaskHistoryEntry, OnlineTaskRef } from "@openorc/protocol";
import { core } from "./rpc";
import { readTaskContent } from "./task-access-cache";
import { organizationContentGate } from "./organization-content-gate";

export function useTaskHistory(reference: OnlineTaskRef) {
  const history = useInfiniteQuery({
    queryKey: onlineTaskKey(reference, "activity", { id: reference.id }),
    queryFn: ({ pageParam }) =>
      readTaskContent(organizationContentGate, reference, () =>
        core.call("tasks.online.activity", { spaceId: reference.spaceId, id: reference.id, limit: 100, ...(pageParam && { cursor: pageParam }) }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.cursor ?? undefined,
    meta: { tags: onlineTaskTags(reference.spaceId) },
    retry: false,
    refetchInterval: 30_000,
  });
  const changed = new Set(history.data?.pages.map((page) => page.accessRevision)).size > 1;
  const error = changed ? new Error("Project access changed. Try again.") : history.error;
  const entries = error ? [] : [...new Map((history.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => [entry.id, entry])).values()];
  return { ...history, error, entries };
}

/** One history entry in words. */
export function activityWords(entry: OnlineTaskHistoryEntry): string {
  // A move between board columns, named as the columns were then; one out of a removed column keeps its status.
  if (entry.column?.after) return `Moved to ${entry.column.after}`;
  if (entry.column?.before && entry.kind === "edited" && !Object.keys(entry.changes).length) return `Taken out of ${entry.column.before}`;
  if (entry.kind === "edited") {
    const fields = Object.keys(entry.changes).map((field) => (field === "spec" ? "description" : field));
    return fields.length ? `Updated ${fields.join(", ")}` : "Updated task";
  }
  const words = { created: "Created task", assigned: "Changed assignee", unassigned: "Removed assignee", status_changed: "Changed status", thread_linked: "Linked thread" };
  return words[entry.kind];
}
