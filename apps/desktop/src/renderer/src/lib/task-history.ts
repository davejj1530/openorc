import { useInfiniteQuery } from "@tanstack/react-query";
import { onlineTaskKey, onlineTaskTags } from "@openorc/client";
import type { OnlineTaskRef } from "@openorc/protocol";
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
