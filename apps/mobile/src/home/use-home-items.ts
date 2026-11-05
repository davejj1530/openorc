import { cachedListPage, NEEDS_YOU_PAGE, sidebarDayList, sidebarListGrows, sidebarThreadPage, THREAD_PAGE, threadFoldIds, useChildThreadPages, type SidebarFilter } from "@openorc/client";
import { WORKSPACE_ID, type InboxList, type ThreadSummary } from "@openorc/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useContext, useEffect, useState } from "react";
import { useRpc, useRpcs } from "../client";
import { HostContext } from "../connection/host-context";
import { projectChoices } from "../projects";
import { homeItems, homeWaiting, type HomeList, type HomeOptions } from "./home-items";
import { useHomeFilter } from "./filter";
import { pruneMissingFolds, toggleFold, toggleThreadChildren, useFolds } from "./folds";

/** How long rows a reader unfolds take to rise in. */
const OPENING_MS = 500;
const NO_IDS: string[] = [];

/** The threads the host's inbox says wait on you that no loaded page lists, read one by one. */
function useWaitingElsewhere(inbox: InboxList | undefined, listed: ReadonlySet<string>): ThreadSummary[] {
  const ids = inbox ? [...new Set(inbox.items.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : [])))].filter((id) => !listed.has(id)) : NO_IDS;
  const reads = useRpcs(
    "threads.get",
    ids.map((id) => ({ id })),
  );
  return reads.flatMap((read) => (read.data ? [read.data] : []));
}

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

/** The open thread's family when no loaded page holds it, so it shows in its day. */
function useSelectedFamily(selected: ThreadSummary | null, filter: SidebarFilter, listed: ReadonlySet<string>, children: ReturnType<typeof useChildThreadPages>) {
  return useRpc(
    "threads.list",
    { projectId: selected?.projectId, filter, includeChildren: true, limit: 1, selectedId: selected?.id, ...children.params(selected?.projectId) },
    { enabled: Boolean(selected && !listed.has(selected.id)) },
  ).data;
}

/**
 * The host's threads as one list across its projects, newest work first, read a page at a time; pins come from their
 * own read so an old pin still leads, and so do the threads that need you, so a folded day can still show them. The
 * list reads on by itself until every open day is whole, and Older pages on request.
 */
function useThreadList(connected: boolean, selectedId: string | undefined) {
  const projects = useRpc("projects.list", {});
  const { filter, pinnedOnly } = useHomeFilter();
  const [limit, setLimit] = useState(THREAD_PAGE);
  const children = useChildThreadPages();
  const cache = useQueryClient();
  const choices = projectChoices(projects.data);
  const projectIds = choices.map((project) => project.id).sort();
  const listed = { projectIds, filter, orderBy: "activity" as const, includeChildren: true, ...children.params() };
  const params = [{ ...listed, pinnedOnly, limit: limit + 1 }];
  const lists = useRpcs("threads.list", params, { refetchInterval: 60_000 });
  const besides = { enabled: filter === "active" && !pinnedOnly, refetchInterval: 60_000 };
  const pins = useRpc("threads.list", { ...listed, pinnedOnly: true }, besides);
  const needsYou = useRpc("threads.list", { ...listed, needsYou: true, limit: NEEDS_YOU_PAGE }, besides);
  const fetched = lists.map((list, index) => (list.data ? { rows: list.data, limit } : cachedListPage(cache, params[index]!)));
  const opened = useRpc("threads.get", { id: selectedId ?? "" }, { enabled: Boolean(selectedId) }).data;
  const selected = opened && projectIds.includes(opened.projectId) ? opened : null;
  const family = useSelectedFamily(selected, filter, new Set(fetched.flatMap((page) => page?.rows.map((thread) => thread.id) ?? [])), children);
  const now = Date.now();
  const withFamily = (rows: readonly ThreadSummary[] | undefined) => (rows ? [...new Map([...rows, ...(family ?? [])].map((thread) => [thread.id, thread])).values()] : rows);
  const pages = fetched.map((page) => sidebarThreadPage({ projectId: selected?.projectId ?? WORKSPACE_ID, fetched: withFamily(page?.rows), selected, filter, limit: page?.limit ?? limit, now }));
  const apart = (rows: ThreadSummary[] | undefined) => sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: rows, selected: null, filter, limit: Number.MAX_SAFE_INTEGER, now });
  const days = sidebarDayList({ pages, pins: apart(pins.data), needsYou: apart(needsYou.data), pinnedOnly, activeId: selectedId, now });
  const read = [...(pins.data ?? []), ...(needsYou.data ?? []), ...fetched.flatMap((page) => page?.rows ?? [])];
  const list: HomeList = { days, read, names: new Map(choices.map(({ id, name }) => [id, name])), failed: connected && lists.some((each) => each.isError) };
  const pending = lists.some((each) => each.isPending);
  return { projects, lists, list, filter, pinnedOnly, children, pending, limit, showMore: () => setLimit((old) => old + THREAD_PAGE) };
}

/**
 * Home's rows from the scope's host's lists, folded as the reader left them. While the phone is not `connected` a list
 * that fails keeps the threads it had and shows no retry: the header says once why. `needsYou` lists a partner host's
 * waiting threads here, or this host's under the shown one's Needs you.
 */
export function useHomeItems(connected: boolean, needsYou: Pick<HomeOptions, "partnerWaiting" | "waitingShownElsewhere" | "selectedId"> = {}) {
  const { projects, lists, list, filter, pinnedOnly, children, pending, limit, showMore } = useThreadList(connected, needsYou.selectedId);
  // A partner's sections fold on their own host.
  const host = useContext(HostContext);
  const collapsed = useFolds(host);
  const foldedIds = threadFoldIds(collapsed);
  const folded = useRpcs(
    "threads.get",
    foldedIds.map((id) => ({ id })),
    { enabled: connected },
  );
  const missingKey = JSON.stringify(foldedIds.filter((_, index) => folded[index]?.data === null));
  useEffect(() => {
    if (connected) pruneMissingFolds(new Set(JSON.parse(missingKey) as string[]), host);
  }, [connected, missingKey, host]);
  const grows = !pinnedOnly && !pending && sidebarListGrows({ end: list.days.end, hasMore: list.days.hasMore, collapsed, limit });
  useEffect(() => {
    if (grows) showMore();
  }, [grows, limit, showMore]);
  const [opened, setOpened] = useOpening();
  const inbox = useRpc("inbox.list", {}, { refetchInterval: 60_000 });
  const waiting = useWaitingElsewhere(inbox.data, new Set(list.read.map((thread) => thread.id)));
  const options: HomeOptions = { now: Date.now(), filter, pinnedOnly, collapsed, waiting, projectsFailed: connected && projects.isError, opened, childLimits: children.limits, ...needsYou };
  const items = homeItems(list, options);
  return {
    items,
    /** This host's threads waiting on you, for the shown host's Needs you when this is the partner. */
    waiting: homeWaiting(list, options),
    showMore,
    showMoreChildren: children.showMore,
    toggleThread: (id: string, expanded: boolean) => toggleThreadChildren(id, expanded, host),
    /** Folds or opens a part of the list by its key; a part the reader opens rises its rows in. */
    toggle: (key: string) => {
      if (items.some((item) => item.kind === "section" && item.key === key && !item.open)) setOpened(key);
      toggleFold(key, host);
    },
    /** Asks the host again for a list it could not give: the projects, or the threads. */
    retry: (projectsList: boolean) => {
      if (projectsList) void projects.refetch();
      else lists.filter((each) => each.isError).forEach((each) => void each.refetch());
    },
  };
}
