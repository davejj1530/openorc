import { listedThreads, sidebarFoldKey, sidebarSectionOpen, THREAD_PAGE, threadFoldIds, threadListParams, type SidebarFilter } from "@openorc/client";
import type { InboxList, ThreadSummary } from "@openorc/protocol";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useContext, useEffect, useState } from "react";
import { useRpc, useRpcs } from "../client";
import { HostContext } from "../connection/host-context";
import { projectChoices } from "../projects";
import { homeItems, homeWaiting, type HomeOptions, type ProjectThreads } from "./home-items";
import { useHomeFilter } from "./filter";
import { pruneMissingFolds, toggleFold, toggleThreadChildren, useFolds } from "./folds";

const listParams = (projectId: string, filter: SidebarFilter, limit: number) => threadListParams(projectId, filter, limit);
/** How long rows a reader unfolds take to rise in. */
const OPENING_MS = 500;
const NO_IDS: string[] = [];

/**
 * A project's threads as Home shows them: its page, or while Show more's next page loads, the largest page it already
 * read at that page's size. The next page has its own read, so without this the rows would empty under the finger.
 */
function shownPage(cache: QueryClient, group: Omit<ProjectThreads, "threads">, filter: SidebarFilter, threads: readonly ThreadSummary[] | undefined): ProjectThreads {
  if (threads) return { ...group, threads };
  for (let limit = group.limit - THREAD_PAGE; limit >= THREAD_PAGE; limit -= THREAD_PAGE) {
    const page = cache.getQueryData<ThreadSummary[]>(["threads.list", listParams(group.id, filter, limit)]);
    if (page) return { ...group, threads: page, limit };
  }
  return { ...group, threads: undefined };
}

/** The threads the Mac's inbox says wait on you that no loaded page lists, read one by one. */
function useWaitingElsewhere(inbox: InboxList | undefined, listed: ReadonlySet<string>): ThreadSummary[] {
  const ids = inbox ? [...new Set(inbox.items.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : [])))].filter((id) => !listed.has(id)) : NO_IDS;
  const reads = useRpcs(
    "threads.get",
    ids.map((id) => ({ id })),
  );
  return reads.flatMap((read) => (read.data ? [read.data] : []));
}

/** The project a reader just unfolded, for a moment, so only a fold they open animates. */
function useOpening(): [string | null, (projectId: string) => void] {
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    const timer = setTimeout(() => setOpened(null), OPENING_MS);
    return () => clearTimeout(timer);
  }, [opened]);
  return [opened, setOpened];
}

/**
 * Home's rows from the scope's host's lists, each project a page at a time and folded as the reader left it. While the
 * phone is not `connected` a list that fails keeps the threads it had and shows no retry: the header says once why.
 * `needsYou` lists a partner host's waiting threads here, or this host's under the shown one's Needs you.
 */
export function useHomeItems(connected: boolean, needsYou: Pick<HomeOptions, "partnerWaiting" | "waitingShownElsewhere"> = {}) {
  const projects = useRpc("projects.list", {});
  const { filter, pinnedOnly } = useHomeFilter();
  // How many threads each project shows per list (active or archived), a page more for each Show more.
  const [limits, setLimits] = useState<Record<string, number>>({});
  const limitKey = (projectId: string) => `${listedThreads(filter)}:${projectId}`;
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
  const [opened, setOpened] = useOpening();
  const groups = projectChoices(projects.data).map(({ id, name }) => ({ id, name, limit: limits[limitKey(id)] ?? THREAD_PAGE }));
  const lists = useRpcs(
    "threads.list",
    groups.map((group) => listParams(group.id, filter, group.limit)),
    { refetchInterval: 60_000 },
  );
  const inbox = useRpc("inbox.list", {}, { refetchInterval: 60_000 });
  const cache = useQueryClient();
  const shown = groups.map((group, index) => shownPage(cache, { ...group, failed: connected && Boolean(lists[index]?.isError) }, filter, lists[index]?.data));
  const listed = new Set(shown.flatMap((group) => group.threads?.map((thread) => thread.id) ?? []));
  const waiting = useWaitingElsewhere(inbox.data, listed);
  const options: HomeOptions = { now: Date.now(), filter, pinnedOnly, collapsed, waiting, projectsFailed: connected && projects.isError, opened, ...needsYou };
  return {
    items: homeItems(shown, options),
    /** This host's threads waiting on you, for the shown host's Needs you when this is the partner. */
    waiting: homeWaiting(shown, options),
    showMore: (projectId: string) => setLimits((current) => ({ ...current, [limitKey(projectId)]: (current[limitKey(projectId)] ?? THREAD_PAGE) + THREAD_PAGE })),
    toggleThread: (id: string, expanded: boolean) => toggleThreadChildren(id, expanded, host),
    /** Folds or opens a section; a project the reader opens rises its rows in. */
    toggle: (key: string, projectId: string) => {
      if (key === sidebarFoldKey.project(projectId) && !sidebarSectionOpen(collapsed, "project", projectId)) setOpened(projectId);
      toggleFold(key, host);
    },
    /** Asks the Mac again for a list it could not give: a project's threads, or the projects. */
    retry: (projectId: string | null) => {
      const index = groups.findIndex((group) => group.id === projectId);
      void (index === -1 ? projects.refetch() : lists[index]?.refetch());
    },
  };
}
