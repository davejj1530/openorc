import { useInfiniteQuery } from "@tanstack/react-query";
import { onlineTaskKey, onlineTaskTags } from "@openorc/client";
import { core } from "./rpc";
import type { TaskOnlineScope } from "./task-online-query";

export function useTaskRoster(scope: TaskOnlineScope, projectId: string, enabled: boolean, search: string) {
  const roster = useInfiniteQuery({
    queryKey: onlineTaskKey(scope, "assignees", { projectId, search }),
    queryFn: ({ pageParam }) => core.call("tasks.online.assignees", { spaceId: scope.spaceId, projectId, ...(search && { query: search }), ...(pageParam && { cursor: pageParam }) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.cursor ?? undefined,
    meta: { tags: onlineTaskTags(scope.spaceId) },
    enabled,
    retry: false,
  });
  const people = [...new Map((roster.data?.pages.flatMap((page) => page.people) ?? []).map((person) => [person.memberId, person])).values()];
  const changed = new Set(roster.data?.pages.map((page) => page.accessRevision)).size > 1;
  return { ...roster, people: changed || roster.error ? [] : people, error: changed ? new Error("Project access changed. Try again.") : roster.error };
}
