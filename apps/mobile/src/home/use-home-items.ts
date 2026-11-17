import {
  cachedListPage,
  moreRows,
  NEEDS_YOU_PAGE,
  resolvedBefore,
  resolvedRows,
  SIDEBAR_LIST,
  sidebarDayList,
  sidebarGroupsGrow,
  sidebarSectionOpen,
  sidebarThreadPage,
  THREAD_PAGE,
  threadFoldIds,
  useChildThreadPages,
  useSidebarNow,
  type ListLayout,
  type SidebarFilter,
} from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useRpc, useRpcs } from "../client";
import { projectChoices } from "../projects";
import { macScope, spaceScope } from "../spaces/list-scope";
import { useSpaces } from "../spaces/use-spaces";
import { homeCalls, homeItems, homeLayout, type HomeList, type HomeOptions } from "./home-items";
import { hiddenIn, MAC_SCOPE, ownershipIn, pruneHidden, useHomeFilter } from "./filter";
import { pruneMissingFolds, toggleFold, toggleThreadChildren, useFolds } from "./folds";

/** How long rows a reader unfolds take to rise in. */
const OPENING_MS = 500;
/** The part a reader just unfolded, for a moment, so only a fold they open animates. */
function useOpening(): [string | null, (key: string) => void] {
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    const timer = setTimeout(() => setOpened(null), OPENING_MS);
    return () => clearTimeout(timer);
  }, [opened]);
  return [opened, setOpened];
}

/** The open thread's family when no loaded page holds it, so it shows in its project's group. */
function useSelectedFamily(selected: ThreadSummary | null, filter: SidebarFilter, listed: ReadonlySet<string>, children: ReturnType<typeof useChildThreadPages>, space: { spaceId?: string }) {
  return useRpc(
    "threads.list",
    { ...space, projectId: selected?.projectId, filter, includeChildren: true, limit: 1, selectedId: selected?.id, ...children.params(selected?.projectId) },
    { enabled: Boolean(selected && !listed.has(selected.id)) },
  ).data;
}

/** Whose threads Home lists: the space it shows, or the Mac alone, and whether reading that space's projects failed. */
export function useListScope() {
  const projects = useRpc("projects.list", {});
  const account = useSpaces();
  const space = account.state === "ready" ? account.current : null;
  const spaceProjects = useRpc("spaces.projects", { spaceId: space?.id ?? "" }, { enabled: space !== null });
  const scope = space ? spaceScope(space, spaceProjects.data) : macScope(projectChoices(projects.data));
  const key = space?.id ?? MAC_SCOPE;
  const known = (space ? spaceProjects.isSuccess : projects.isSuccess) ? JSON.stringify(scope.groups.map((group) => group.id)) : null;
  useEffect(() => {
    if (known) pruneHidden(key, new Set(JSON.parse(known) as string[]));
  }, [key, known]);
  return { projects, scope, key, inSpace: "spaceId" in scope.asks ? scope.asks : {}, failed: space !== null && spaceProjects.isError };
}

/**
 * The threads of the Mac, or of the space Home shows, as one list across projects, newest work first, read a page at a time; pins come from their
 * own read so an old pin still leads, and so do the threads that need you, so their groups show them however far back
 * they lie, and, while Resolved is open, the threads put there. The list reads on by itself until every group is whole, and
 * Resolved pages on request.
 */
function useThreadList(connected: boolean, selectedId: string | undefined, resolvedOpen: boolean) {
  const { projects, scope, key, inSpace, failed: spaceFailed } = useListScope();
  const filter = useHomeFilter();
  const hidden = hiddenIn(filter, key);
  const { pinnedOnly } = filter;
  const [limit, setLimit] = useState(THREAD_PAGE);
  const [resolvedLimit, setResolvedLimit] = useState(THREAD_PAGE);
  const children = useChildThreadPages();
  const cache = useQueryClient();
  const owned = "spaceId" in scope.asks ? { ownership: ownershipIn(filter, scope.asks.spaceId) } : {};
  const listed = { ...scope.asks, ...owned, filter: "active" as const, orderBy: "activity" as const, includeChildren: true, ...children.params() };
  const params = [{ ...listed, pinnedOnly, limit: limit + 1 }];
  const lists = useRpcs("threads.list", params, { refetchInterval: 60_000 });
  const besides = { enabled: !pinnedOnly, refetchInterval: 60_000 };
  const pins = useRpc("threads.list", { ...listed, pinnedOnly: true }, besides);
  const needsYou = useRpc("threads.list", { ...listed, needsYou: true, limit: NEEDS_YOU_PAGE }, besides);
  const resolved = useRpc("threads.list", { ...listed, filter: "archived", limit: resolvedLimit + 1 }, { ...besides, enabled: besides.enabled && resolvedOpen });
  const resolvedCount = useRpc("threads.resolvedCount", { ...inSpace, ...owned, projectIds: scope.localIds, quietBefore: resolvedBefore(Date.now()) }, besides);
  const fetched = lists.map((list, index) => (list.data ? { rows: list.data, limit } : cachedListPage(cache, params[index]!)));
  const opened = useRpc("threads.get", { id: selectedId ?? "" }, { enabled: Boolean(selectedId) }).data;
  const selected = opened && scope.names.has(opened.projectId) ? opened : null;
  const listedIds = new Set([...fetched.flatMap((page) => page?.rows ?? []), ...(resolved.data ?? [])].map((thread) => thread.id));
  const family = useSelectedFamily(selected, selected?.archivedAt ? "archived" : "active", listedIds, children, inSpace);
  const now = useSidebarNow();
  // A workspace the person unticked leaves the list, its pins and Resolved included, until it is ticked again.
  const inShown = <T extends readonly ThreadSummary[] | undefined>(rows: T): T =>
    (hidden.length && rows ? rows.filter((row) => !hidden.includes(scope.groupOf.get(row.projectId) ?? row.projectId)) : rows) as T;
  const withFamily = (rows: readonly ThreadSummary[] | undefined) => inShown(rows ? [...new Map([...rows, ...(family ?? [])].map((thread) => [thread.id, thread])).values()] : rows);
  const page = (rows: readonly ThreadSummary[] | undefined, filter: SidebarFilter, shown: number) =>
    sidebarThreadPage({ projectId: selected?.projectId ?? WORKSPACE_ID, fetched: withFamily(rows), selected, filter, limit: shown, now });
  const pages = fetched.map((fetchedPage) => page(fetchedPage?.rows, "active", fetchedPage?.limit ?? limit));
  const apart = (rows: ThreadSummary[] | undefined) => sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: inShown(rows), selected: null, filter: "active", limit: Number.MAX_SAFE_INTEGER, now });
  const putRows = resolvedRows(resolvedOpen, resolved.data, selected);
  const resolvedPage = putRows && page(putRows, "archived", resolvedLimit);
  const days = sidebarDayList({ pages, pins: apart(pins.data), needsYou: apart(needsYou.data), resolved: resolvedPage, pinnedOnly, activeId: selectedId, now });
  const list: HomeList = {
    days,
    names: scope.names,
    groups: scope.groups.filter((group) => !hidden.includes(group.id)),
    groupOf: scope.groupOf,
    failed: connected && (lists.some((each) => each.isError) || spaceFailed),
    listed: fetched.every(Boolean),
    resolvedCount: resolvedCount.data,
  };
  const pending = lists.some((each) => each.isPending);
  return {
    projects,
    lists,
    list,
    pinnedOnly,
    children,
    pending,
    limit,
    /** The next page: of the list, and of Resolved's own read, whose quiet threads come from the list. */
    showMore: () => {
      setLimit((old) => old + THREAD_PAGE);
      setResolvedLimit((old) => old + THREAD_PAGE);
    },
  };
}

/**
 * Which rows each project shows and the projects' order, kept from one settled read to the next, so work in one project
 * never moves it past another and a thread "Show N more" reached stays. Before the lists settle, nothing is kept.
 */
function useHomeLayout(list: HomeList, now: number, ready: boolean): { layout: ListLayout; reach(ids: readonly string[]): void } {
  const [reached, setReached] = useState<readonly string[]>([]);
  const remembered = useRef<ListLayout | null>(null);
  const layout = homeLayout(list, { now, reached }, ready ? remembered.current : null);
  useEffect(() => {
    if (ready) remembered.current = layout;
  });
  return { layout, reach: (ids) => setReached((old) => [...old, ...ids]) };
}

/**
 * Home's rows from the shown Mac's lists, folded as the reader left them. While the phone is not `connected` a list
 * that fails keeps the threads it had and shows no retry: the header says once why.
 */
export function useHomeItems(connected: boolean, selected: Pick<HomeOptions, "selectedId"> = {}) {
  const collapsed = useFolds();
  const { projects, lists, list, pinnedOnly, children, pending, limit, showMore } = useThreadList(connected, selected.selectedId, sidebarSectionOpen(collapsed, "resolved", SIDEBAR_LIST));
  const foldedIds = threadFoldIds(collapsed);
  const folded = useRpcs(
    "threads.get",
    foldedIds.map((id) => ({ id })),
    { enabled: connected },
  );
  const missingKey = JSON.stringify(foldedIds.filter((_, index) => folded[index]?.data === null));
  useEffect(() => {
    if (connected) pruneMissingFolds(new Set(JSON.parse(missingKey) as string[]));
  }, [connected, missingKey]);
  // Every group whole: the list reads on by itself until its threads reach Resolved.
  const grows = !pinnedOnly && !pending && sidebarGroupsGrow({ end: list.days.end, hasMore: list.days.hasMore, limit });
  useEffect(() => {
    if (grows) showMore();
  }, [grows, limit, showMore]);
  const [opened, setOpened] = useOpening();
  const now = Date.now();
  const { layout, reach } = useHomeLayout(list, now, !pending);
  const options: HomeOptions = { now, pinnedOnly, collapsed, projectsFailed: connected && projects.isError, opened, layout, childLimits: children.limits, ...selected };
  const items = homeItems(list, options);
  return {
    items,
    /** What calls the person in the groups, for the lines at the list's edges. */
    calls: homeCalls(items, list),
    showMore,
    /** The next ten of a project's threads, the most recently active of those without a row. */
    showMoreInGroup: (projectId: string) => {
      const roots = list.days.rest.filter((root) => (list.groupOf.get(root.projectId) ?? root.projectId) === projectId);
      reach(moreRows(roots, layout.rows.get(projectId) ?? []));
    },
    showMoreChildren: children.showMore,
    toggleThread: (id: string, expanded: boolean) => toggleThreadChildren(id, expanded),
    /** Folds or opens a part of the list by its key; a part the reader opens rises its rows in. */
    toggle: (key: string) => {
      if (items.some((item) => (item.kind === "section" || item.kind === "project") && item.key === key && !item.open)) setOpened(key);
      toggleFold(key);
    },
    /** Asks the host again for a list it could not give: the projects, or the threads. */
    retry: (projectsList: boolean) => {
      if (projectsList) void projects.refetch();
      else lists.filter((each) => each.isError).forEach((each) => void each.refetch());
    },
  };
}
