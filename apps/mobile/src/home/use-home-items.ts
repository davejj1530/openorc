import { THREAD_PAGE, threadListParams } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useState } from "react";
import { queryClient, useRpc, useRpcs } from "../client";
import { projectChoices } from "../projects";
import { homeItems, type ProjectThreads } from "./home-items";

const listParams = (projectId: string, limit: number) => threadListParams(projectId, "active", limit);

/**
 * A project's threads as Home shows them: its page, or while Show more's next page loads, the largest page it already
 * read at that page's size. The next page has its own read, so without this the rows would empty under the finger.
 */
function shownPage(group: Omit<ProjectThreads, "threads">, threads: readonly ThreadSummary[] | undefined): ProjectThreads {
  if (threads) return { ...group, threads };
  for (let limit = group.limit - THREAD_PAGE; limit >= THREAD_PAGE; limit -= THREAD_PAGE) {
    const page = queryClient.getQueryData<ThreadSummary[]>(["threads.list", listParams(group.id, limit)]);
    if (page) return { ...group, threads: page, limit };
  }
  return { ...group, threads: undefined };
}

/** Home's rows from the shown Mac's lists, each project a page at a time, as the sidebar keeps them. */
export function useHomeItems() {
  const projects = useRpc("projects.list", {});
  // How many threads each project shows, a page more for each Show more.
  const [limits, setLimits] = useState<Record<string, number>>({});
  const groups = projectChoices(projects.data).map(({ id, name }) => ({ id, name, limit: limits[id] ?? THREAD_PAGE }));
  const lists = useRpcs(
    "threads.list",
    groups.map((group) => listParams(group.id, group.limit)),
    { refetchInterval: 60_000 },
  );
  return {
    items: homeItems(
      groups.map((group, index) => shownPage(group, lists[index]?.data)),
      Date.now(),
    ),
    showMore: (projectId: string) => setLimits((current) => ({ ...current, [projectId]: (current[projectId] ?? THREAD_PAGE) + THREAD_PAGE })),
  };
}
