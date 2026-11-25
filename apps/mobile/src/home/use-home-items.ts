import {
  cachedListPage,
  moreRows,
  NEEDS_YOU_PAGE,
  resolvedBefore,
  sidebarDayList,
  sidebarGroupsGrow,
  sidebarSectionOpen,
  sidebarThreadPage,
  THREAD_PAGE,
  threadFoldIds,
  useChildThreadPages,
  useSidebarNow,
  type ListLayout,
  type SidebarDayList,
  type SidebarFilter,
  type ThreadPage,
} from "@openorc/client";
import { WORKSPACE_ID, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRpcs } from "../client";
import { NOT_FROM_PHONE } from "../connection/link-connection";
import { projectChoices } from "../projects";
import { macScope, spaceScope, type ListScope } from "../spaces/list-scope";
import { useSpaces } from "../spaces/use-spaces";
import { homeCalls, homeItems, homeLayout, type HomeList, type HomeOptions, type ProjectResolved } from "./home-items";
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

/** A read as the list shows it. `within` makes it one project's own, which holds the open thread only when it is that project's. */
type ReadPage = (rows: readonly ThreadSummary[] | undefined, filter: SidebarFilter, shown: number, within?: string) => ThreadPage;

/**
 * Each project's Resolved. The host counts every project's, so one that holds none has no door; an older Mac that
 * cannot count keeps them all. One the reader opened is read for its project alone: the threads put there and, from the
 * project's own list, those quiet since before yesterday. That list reads on by itself until it reaches them; past
 * that the reader asks. A folded one keeps the open thread's tree from the list's own pages.
 */
function useProjectResolved({
  scope,
  whose,
  listed,
  page,
  days,
  collapsed,
  enabled,
  activeId,
  now,
}: {
  scope: Pick<ListScope, "groups" | "groupOf">;
  /** The space and whose threads in it, which a count asks by; nothing for the Mac alone. */
  whose: { spaceId?: string; ownership?: "mine" | "everyone" };
  /** What every one of the list's reads asks with. */
  listed: RpcParams<"threads.list">;
  page: ReadPage;
  days: SidebarDayList;
  collapsed: readonly string[];
  enabled: boolean;
  activeId: string | undefined;
  now: number;
}) {
  const cache = useQueryClient();
  const [limits, setLimits] = useState<Readonly<Record<string, number>>>({});
  // Every id a thread may carry for a group's project, which its own reads ask by.
  const idsOf = (group: string) => [...scope.groupOf].filter(([, key]) => key === group).map(([id]) => id);
  const groups = scope.groups.map((group) => group.id);
  const counts = useRpcs(
    "threads.resolvedCount",
    groups.map((id) => ({ ...whose, projectIds: idsOf(id), quietBefore: resolvedBefore(now) })),
    { enabled, refetchInterval: 60_000 },
  );
  const opened = (id: string) => sidebarSectionOpen(collapsed, "project", id) && sidebarSectionOpen(collapsed, "resolved", id);
  const reading = enabled ? groups.filter(opened) : [];
  const reads = (filter: SidebarFilter) => reading.map((id) => ({ ...listed, projectIds: idsOf(id), filter, limit: (limits[id] ?? THREAD_PAGE) + 1 }));
  const [listParams, putParams] = [reads("active"), reads("archived")];
  const lists = useRpcs("threads.list", listParams, { refetchInterval: 60_000 });
  const puts = useRpcs("threads.list", putParams, { refetchInterval: 60_000 });
  const parts = new Map(
    reading.map((id, index) => {
      const limit = limits[id] ?? THREAD_PAGE;
      // While a longer page loads, each read keeps the last page it read, as the list's own does.
      const kept = (queries: typeof lists, params: typeof listParams, filter: SidebarFilter) => {
        const rows = queries[index]?.data;
        const last = rows ? { rows, limit } : cachedListPage(cache, params[index]!);
        return page(last?.rows, filter, last?.limit ?? limit, id);
      };
      const own = sidebarDayList({ pages: [kept(lists, listParams, "active")], resolved: kept(puts, putParams, "archived"), pinnedOnly: false, activeId, now });
      const pending = Boolean(lists[index]?.isPending || puts[index]?.isPending);
      const part: ProjectResolved = { open: true, roots: own.resolved.roots, all: own.all, hasMore: own.resolved.hasMore, pending };
      return [id, { part, grows: !pending && sidebarGroupsGrow({ end: own.end, hasMore: own.hasMore, limit }) }];
    }),
  );
  const more = useCallback((ids: readonly string[]) => setLimits((old) => ({ ...old, ...Object.fromEntries(ids.map((id) => [id, (old[id] ?? THREAD_PAGE) + THREAD_PAGE])) })), []);
  const growing = JSON.stringify(reading.filter((id) => parts.get(id)?.grows));
  useEffect(() => {
    const ids = JSON.parse(growing) as string[];
    if (ids.length) more(ids);
  }, [growing, limits, more]);
  const held = days.shown(days.resolved.roots, false);
  // A project shows no door until the host has counted some; only an older Mac, which cannot count, keeps them all.
  const none = new Set(groups.filter((_, index) => !counts[index]?.data && counts[index]?.error?.message !== NOT_FROM_PHONE));
  return {
    of: (projectId: string): ProjectResolved | null => {
      const own = held.filter((root) => (scope.groupOf.get(root.projectId) ?? root.projectId) === projectId);
      // The count is a moment old: a project whose open thread was just resolved holds it already.
      if (!enabled || (none.has(projectId) && !own.length)) return null;
      return parts.get(projectId)?.part ?? { open: false, roots: own, all: days.all, hasMore: false, pending: false };
    },
    showMore: (projectId: string) => more([projectId]),
  };
}

/**
 * The threads of the Mac, or of the space Home shows, as one list across projects, newest work first, read a page at a
 * time; pins come from their own read so an old pin still leads, and so do the threads that need you, so their groups
 * show them however far back they lie. The list reads on by itself until every group is whole; each project's Resolved
 * is read apart, once the reader opens it.
 */
function useThreadList(connected: boolean, selectedId: string | undefined, collapsed: readonly string[]) {
  const { projects, scope, key, inSpace, failed: spaceFailed } = useListScope();
  const filter = useHomeFilter();
  const hidden = hiddenIn(filter, key);
  const { pinnedOnly } = filter;
  const [limit, setLimit] = useState(THREAD_PAGE);
  const children = useChildThreadPages();
  const cache = useQueryClient();
  const owned = "spaceId" in scope.asks ? { ownership: ownershipIn(filter, scope.asks.spaceId) } : {};
  const listed = { ...scope.asks, ...owned, filter: "active" as const, orderBy: "activity" as const, includeChildren: true as const, ...children.params() };
  const params = [{ ...listed, pinnedOnly, limit: limit + 1 }];
  const lists = useRpcs("threads.list", params, { refetchInterval: 60_000 });
  const besides = { enabled: !pinnedOnly, refetchInterval: 60_000 };
  const pins = useRpc("threads.list", { ...listed, pinnedOnly: true }, besides);
  const needsYou = useRpc("threads.list", { ...listed, needsYou: true, limit: NEEDS_YOU_PAGE }, besides);
  const fetched = lists.map((list, index) => (list.data ? { rows: list.data, limit } : cachedListPage(cache, params[index]!)));
  const opened = useRpc("threads.get", { id: selectedId ?? "" }, { enabled: Boolean(selectedId) }).data;
  const selected = opened && scope.names.has(opened.projectId) ? opened : null;
  const listedIds = new Set(fetched.flatMap((page) => page?.rows ?? []).map((thread) => thread.id));
  const family = useSelectedFamily(selected, selected?.archivedAt ? "archived" : "active", listedIds, children, inSpace);
  const now = useSidebarNow();
  const groupOf = (projectId: string) => scope.groupOf.get(projectId) ?? projectId;
  // A workspace the person unticked leaves the list, its pins and Resolved included, until it is ticked again.
  const inShown = <T extends readonly ThreadSummary[] | undefined>(rows: T): T => (hidden.length && rows ? rows.filter((row) => !hidden.includes(groupOf(row.projectId))) : rows) as T;
  const page: ReadPage = (rows, filter, shown, within) => {
    const held = !within || (selected && groupOf(selected.projectId) === within) ? selected : null;
    const own = (family ?? []).filter((thread) => !within || groupOf(thread.projectId) === within);
    const fetchedRows = inShown(rows ? [...new Map([...rows, ...own].map((thread) => [thread.id, thread])).values()] : rows);
    return sidebarThreadPage({ projectId: held?.projectId ?? WORKSPACE_ID, fetched: fetchedRows, selected: held, filter, limit: shown, now });
  };
  const pages = fetched.map((fetchedPage) => page(fetchedPage?.rows, "active", fetchedPage?.limit ?? limit));
  const apart = (rows: ThreadSummary[] | undefined) => sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: inShown(rows), selected: null, filter: "active", limit: Number.MAX_SAFE_INTEGER, now });
  // The open thread's own page when it was put in Resolved, so its project holds it while its Resolved is folded.
  const resolvedPage = selected?.archivedAt ? page([], "archived", THREAD_PAGE) : undefined;
  const days = sidebarDayList({ pages, pins: apart(pins.data), needsYou: apart(needsYou.data), resolved: resolvedPage, pinnedOnly, activeId: selectedId, now });
  const groups = scope.groups.filter((group) => !hidden.includes(group.id));
  const resolved = useProjectResolved({ scope: { groups, groupOf: scope.groupOf }, whose: { ...inSpace, ...owned }, listed, page, days, collapsed, enabled: !pinnedOnly, activeId: selectedId, now });
  const list: HomeList = {
    days,
    names: scope.names,
    groups,
    groupOf: scope.groupOf,
    failed: connected && (lists.some((each) => each.isError) || spaceFailed),
    listed: fetched.every(Boolean),
    resolved: resolved.of,
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
    /** The list's next page. */
    showMore: () => setLimit((old) => old + THREAD_PAGE),
    /** The next page of a project's Resolved. */
    showMoreResolved: resolved.showMore,
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
  const { projects, lists, list, pinnedOnly, children, pending, limit, showMore, showMoreResolved } = useThreadList(connected, selected.selectedId, collapsed);
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
    showMoreResolved,
    /** The next ten of a project's threads, the most recently active of those without a row. */
    showMoreInGroup: (projectId: string) => {
      const roots = list.days.rest.filter((root) => (list.groupOf.get(root.projectId) ?? root.projectId) === projectId);
      reach(moreRows(roots, layout.rows.get(projectId) ?? []));
    },
    showMoreChildren: children.showMore,
    toggleThread: (id: string, expanded: boolean) => toggleThreadChildren(id, expanded),
    /** Folds or opens a part of the list by its key; a part the reader opens rises its rows in. */
    toggle: (key: string) => {
      if (items.some((item) => (item.kind === "section" || item.kind === "project" || item.kind === "resolved") && item.key === key && !item.open)) setOpened(key);
      toggleFold(key);
    },
    /** Asks the host again for a list it could not give: the projects, or the threads. */
    retry: (projectsList: boolean) => {
      if (projectsList) void projects.refetch();
      else lists.filter((each) => each.isError).forEach((each) => void each.refetch());
    },
  };
}
