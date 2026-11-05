import { useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { THREAD_CHILD_PAGE, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import { THREAD_PAGE } from "./sidebar-thread-groups.js";

/** Each parent keeps its page for the life of this list, across folds and thread navigation. */
export function useChildThreadPages() {
  const [projects, setProjects] = useState<Record<string, Record<string, number>>>({});
  return {
    limits: Object.assign({}, ...Object.values(projects)) as Record<string, number>,
    params: (projectId?: string) => {
      const childLimits = projectId ? projects[projectId] : Object.assign({}, ...Object.values(projects));
      return childLimits && Object.keys(childLimits).length ? { childLimits } : {};
    },
    showMore: (projectId: string, parentId: string) =>
      setProjects((old) => ({ ...old, [projectId]: { ...old[projectId], [parentId]: (old[projectId]?.[parentId] ?? THREAD_CHILD_PAGE) + THREAD_PAGE } })),
  };
}

/** Keep loaded rows during paging/search reads; the tree still applies the current search and page limits. */
export function cachedChildPage(cache: QueryClient, params: RpcParams<"threads.list">): ThreadSummary[] | undefined {
  const key = (value: RpcParams<"threads.list">) => JSON.stringify({ ...value, childLimits: undefined, childSearch: undefined });
  return cache
    .getQueryCache()
    .findAll({ queryKey: ["threads.list"], predicate: (query) => key(query.queryKey[1] as RpcParams<"threads.list">) === key(params) && Array.isArray(query.state.data) })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0]?.state.data as ThreadSummary[] | undefined;
}
