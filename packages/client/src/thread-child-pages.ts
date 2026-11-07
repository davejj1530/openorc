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

/** Keep loaded rows during paging reads; the tree still applies the current page limits. */
export function cachedChildPage(cache: QueryClient, params: RpcParams<"threads.list">): ThreadSummary[] | undefined {
  const key = (value: RpcParams<"threads.list">) => JSON.stringify({ ...value, childLimits: undefined });
  return cache
    .getQueryCache()
    .findAll({ queryKey: ["threads.list"], predicate: (query) => key(query.queryKey[1] as RpcParams<"threads.list">) === key(params) && Array.isArray(query.state.data) })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0]?.state.data as ThreadSummary[] | undefined;
}

/** While a longer page loads, a list keeps the last page it read of the same threads, at that page's length. */
export function cachedListPage(cache: QueryClient, params: RpcParams<"threads.list">): { rows: ThreadSummary[]; limit: number } | undefined {
  const exact = cachedChildPage(cache, params);
  if (exact) return { rows: exact, limit: (params.limit ?? exact.length) - 1 };
  const key = (value: RpcParams<"threads.list">) => JSON.stringify({ ...value, childLimits: undefined, limit: undefined });
  const query = cache
    .getQueryCache()
    .findAll({ queryKey: ["threads.list"], predicate: (entry) => key(entry.queryKey[1] as RpcParams<"threads.list">) === key(params) && Array.isArray(entry.state.data) })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0];
  const rows = query?.state.data as ThreadSummary[] | undefined;
  return rows && query ? { rows, limit: ((query.queryKey[1] as RpcParams<"threads.list">).limit ?? rows.length) - 1 } : undefined;
}
