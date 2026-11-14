import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isSubagentThread, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { ALL_WORKSPACES, useLayout } from "../lib/layout";
import {
  type GroupProject,
  type ListLayout,
  type SidebarDayList,
  type SidebarFilter,
  cachedListPage,
  callsThePerson,
  inListOrder,
  listLayout,
  moreRows,
  NEEDS_YOU_PAGE,
  pinOrder,
  projectRows,
  rootStatuses,
  subthreadStatuses,
  projectGroups,
  cloudProjects,
  inShownWorkspaces,
  sidebarDayList,
  sidebarFoldKey,
  sidebarGroupsGrow,
  SIDEBAR_LIST,
  sidebarSectionOpen,
  sidebarThreadPage,
  THREAD_PAGE,
  threadTreeRows,
  threadFoldIds,
  resolvedRows,
  threadResolved,
  useChildThreadPages,
  useSidebarNow,
  waitingRoots,
  WORKSPACES_FOLD,
} from "@openorc/client";
import { useOrclingChatIds } from "../lib/orclings";
import { useRpc, useRpcs } from "../lib/client";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { ChevronRight, FolderPlus, Search } from "./icons";
import { ResolvedDrawer, useResolveThread, useThreadDrop } from "./SidebarResolved";
import { ListEdgeLines, useListEdges, type EdgeCall } from "./SidebarListEdge";
import { SidebarListHead } from "./SidebarListHead";
import { SidebarProjectGroup } from "./SidebarProjectGroup";
import { SidebarThreadFilter } from "./SidebarThreadFilter";
import type { RowProject } from "./ThreadLibraryRow";
import { ThreadTreeList } from "./ThreadTreeList";
import { IconButton, Tooltip } from "./ui";
import { useListHold } from "../lib/use-list-hold";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { cn } from "../lib/cn";

/** Every project, and every project's id with the Workspace's, which the list reads all of. */
export function useSidebarProjects() {
  const projects = useRpc("projects.list", {});
  useEffect(() => {
    if (!projects.data) return;
    const { workspace: chosen, setWorkspace } = useLayout.getState();
    // A removed project can't stay the app's scope; it goes back to All projects.
    if (chosen !== ALL_WORKSPACES && !projects.data.some((p) => p.id === chosen)) setWorkspace(ALL_WORKSPACES);
  }, [projects.data]);
  const all = [WORKSPACE_ID, ...(projects.data ?? []).map((project) => project.id)].sort();
  return { query: projects, all };
}

/** Loading an off-page selection must not replace the list's stable page query. */
type ChildPages = ReturnType<typeof useChildThreadPages>;

function useSelectedFamily(selected: ThreadSummary | null | undefined, filter: SidebarFilter, pages: readonly (readonly ThreadSummary[] | undefined)[], children: ChildPages) {
  const offPage = Boolean(selected && !pages.some((page) => page?.some((thread) => thread.id === selected.id)));
  const family = useRpc(
    "threads.list",
    {
      projectId: selected?.projectId,
      filter,
      includeChildren: true,
      limit: 1,
      selectedId: selected?.id,
      ...children.params(selected?.projectId),
    },
    { enabled: offPage },
  ).data;
  // Once the pages hold the selection this read stops refreshing but keeps its last answer, which would cover their newer rows.
  return offPage ? family : undefined;
}

function withFamily(page: ThreadSummary[] | undefined, family: ThreadSummary[] | undefined, projectIds: readonly string[]): ThreadSummary[] | undefined {
  if (!page) return page;
  return [...new Map([...page, ...(family ?? []).filter((thread) => projectIds.includes(thread.projectId))].map((thread) => [thread.id, thread])).values()];
}

/** The list keeps its filters and loaded pages across app destinations, and while it is folded. */
export function SidebarThreadBrowser() {
  const children = useChildThreadPages();
  const saved = useLayout((s) => s.collapsed);
  const ids = threadFoldIds(saved);
  const reads = useRpcs(
    "threads.get",
    ids.map((id) => ({ id })),
  );
  const missingKey = JSON.stringify(ids.filter((_, index) => reads[index]?.data === null));
  useEffect(() => {
    useLayout.getState().pruneThreadFolds(new Set(JSON.parse(missingKey) as string[]));
  }, [missingKey]);
  return <ThreadGroups children={children} />;
}

/**
 * One list across every project, newest work first, read a page at a time. Pinned threads come from their own read so
 * an old pin still leads the list, and so do the threads that need you, so a project's count holds them all.
 */
function useThreadList(children: ChildPages) {
  const queryClient = useQueryClient();
  const pinnedOnly = useLayout((s) => s.pinnedOnly);
  const hidden = useLayout((s) => s.hiddenWorkspaces);
  const resolvedOpen = useLayout((s) => sidebarSectionOpen(s.collapsed, "resolved", SIDEBAR_LIST));
  const [limit, setLimit] = useState(THREAD_PAGE);
  const [resolvedLimit, setResolvedLimit] = useState(THREAD_PAGE);
  const { query: projects, all: projectIds } = useSidebarProjects();
  const homes = useOrclingChatIds();
  const activeId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const active = useRpc("threads.get", { id: activeId ?? "" }, { enabled: Boolean(activeId) });
  const listed = { projectIds, filter: "active" as const, orderBy: "activity" as const, includeChildren: true, ...children.params() };
  const params = [{ ...listed, pinnedOnly, limit: limit + 1 }];
  const queries = useRpcs("threads.list", params, { enabled: Boolean(projects.data), refetchInterval: 60_000 });
  const besides = { enabled: Boolean(projects.data) && !pinnedOnly, refetchInterval: 60_000 };
  const pins = useRpc("threads.list", { ...listed, pinnedOnly: true }, besides);
  const needsYou = useRpc("threads.list", { ...listed, needsYou: true, limit: NEEDS_YOU_PAGE }, besides);
  // Resolved reads the threads put there only while it is open.
  const resolved = useRpc("threads.list", { ...listed, filter: "archived", limit: resolvedLimit + 1 }, { ...besides, enabled: besides.enabled && resolvedOpen });
  const resolvedPending = resolvedOpen && !pinnedOnly && resolved.isPending;
  const fetched = queries.map((query, index) => (query.data ? { rows: query.data, limit } : cachedListPage(queryClient, params[index]!)));
  const family = useSelectedFamily(active.data, active.data?.archivedAt ? "archived" : "active", [...fetched.map((page) => page?.rows), resolved.data], children);
  const selected = active.data && projectIds.includes(active.data.projectId) && !hidden.includes(active.data.projectId) && (!pinnedOnly || active.data.pinnedAt) ? active.data : null;
  const inShown = (rows: ThreadSummary[] | undefined) => rows && inShownWorkspaces(rows, hidden);
  const page = (rows: ThreadSummary[] | undefined, filter: SidebarFilter, shown: number) =>
    sidebarThreadPage({ projectId: selected?.projectId ?? WORKSPACE_ID, fetched: inShown(withFamily(rows, family, projectIds)), selected, filter, limit: shown, now: Date.now(), hidden: homes });
  const apart = (rows: ThreadSummary[] | undefined) =>
    sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: inShown(rows), selected: null, filter: "active", limit: Number.MAX_SAFE_INTEGER, now: Date.now(), hidden: homes });
  const pages = fetched.map((fetchedPage) => page(fetchedPage?.rows, "active", fetchedPage?.limit ?? limit));
  const putRows = resolvedRows(resolvedOpen, resolved.data, selected);
  return {
    projects,
    /** Every row read, hidden workspaces' too, so a cloud project the person hid still has its place in the filter. */
    seen: [...fetched.map((each) => each?.rows), pins.data, needsYou.data, resolved.data].flatMap((rows) => rows ?? []),
    queries,
    pages,
    pinPage: apart(pins.data),
    needsYouPage: apart(needsYou.data),
    resolvedPage: putRows && page(putRows, "archived", resolvedLimit),
    activeId,
    pinnedOnly,
    pending: queries.some((query) => query.isPending),
    resolvedPending,
    limit,
    loadMore: () => setLimit((old) => old + THREAD_PAGE),
    /** Resolved's next page: of the threads put there, and of the list, where its quiet threads come from. */
    loadMoreResolved: () => {
      setResolvedLimit((old) => old + THREAD_PAGE);
      if (pages.some((each) => each.hasMore)) setLimit((old) => old + THREAD_PAGE);
    },
  };
}

type ThreadList = ReturnType<typeof useThreadList>;

function ListFeedback({ state, shown, snoozed }: { state: ThreadList; shown: number; snoozed: number }) {
  const { projects, queries, pages, pinnedOnly, pending } = state;
  if (projects.isError) return null;
  const hasMore = pages.some((page) => page.hasMore);
  const failed = queries.filter((query) => query.isError);
  if (failed.length)
    return (
      <button className="browser-empty" onClick={() => failed.forEach((query) => void query.refetch())}>
        Couldn’t load threads. Retry
      </button>
    );
  if (pending && !shown) return <p className="browser-empty">Loading threads…</p>;
  // Every project keeps its label, empty or not, so the list comes up empty only with no projects or under the pinned filter.
  if (shown || snoozed || hasMore) return null;
  if (pinnedOnly) return <p className="browser-empty">No pinned threads.</p>;
  return projects.data?.length === 0 ? <p className="browser-empty">No projects yet.</p> : null;
}

/** The list's parts from its pages: pins, the rest, snoozed threads apart, and Resolved. */
function dayList({ pages, pinPage, needsYouPage, resolvedPage, pinnedOnly, activeId }: ThreadList, now: number) {
  return sidebarDayList({ pages, pins: pinPage, needsYou: needsYouPage, resolved: resolvedPage, pinnedOnly, activeId, now });
}

/**
 * The groups' projects in the order projects come, then those only OpenOrc Cloud has, then No project, for the
 * Workspace's threads, which belong to none.
 */
function groupProjects(projects: readonly { id: string; name: string; rootPath: string }[] | undefined, rows: readonly ThreadSummary[]): GroupProject[] {
  return [...(projects ?? []).map(({ id, name, rootPath }) => ({ id, name, rootPath })), ...cloudProjects(rows), { id: WORKSPACE_ID, name: "No project" }];
}

/**
 * Each project's group as the list shows it: open or folded by the reader, the most recently active on top. Every
 * project has one, an empty one too, but the Workspace only while it holds threads or is hidden. While the list is `held`, rows that
 * would arrive, leave or move wait; what the person reaches for lands at once.
 */
function useGroupPages(list: SidebarDayList, projects: readonly GroupProject[], collapsed: readonly string[], { ready, held, now }: { ready: boolean; held: boolean; now: number }) {
  const [more, setMore] = useState<readonly string[]>([]);
  const remembered = useRef<ListLayout | null>(null);
  const hidden = useLayout((s) => s.hiddenWorkspaces);
  const known = ready ? JSON.stringify(projects.map((project) => project.id)) : null;
  useEffect(() => {
    if (known) useLayout.getState().pruneHiddenWorkspaces(JSON.parse(known) as string[]);
  }, [known]);
  const holding = new Set(list.shown(list.rest, false).map((root) => root.id));
  const holdsActive = (root: ThreadSummary) => holding.has(root.id);
  const groups = projectGroups(projects, list.rest, list.all).filter((group) => group.project.id !== WORKSPACE_ID || group.roots.length || hidden.includes(WORKSPACE_ID));
  const statuses = rootStatuses(list.rest, list.all);
  const layout = listLayout(ready ? remembered.current : null, { groups, quiet: (root) => !statuses.get(root.id), now, held, own: [...more, ...holding] });
  useEffect(() => {
    if (ready) remembered.current = layout;
  });
  return inListOrder(groups, layout).map((group) => {
    const id = group.project.id;
    const open = sidebarSectionOpen(collapsed, "project", id);
    const rows = layout.rows.get(id) ?? [];
    return { ...group, open, ...projectRows(group.roots, { rows, open, holdsActive }), showMore: () => setMore((old) => [...old, ...moreRows(group.roots, rows)]) };
  });
}

type GroupPage = ReturnType<typeof useGroupPages>[number];

/** The groups the list draws: none under the pinned filter, and none of a workspace the person hid. */
function drawnGroups(groups: GroupPage[], { pinnedOnly, hidden }: { pinnedOnly: boolean; hidden: readonly string[] }) {
  const shown = groups.filter((group) => !hidden.includes(group.project.id));
  return { groups: pinnedOnly ? [] : shown, everyHidden: groups.length > 0 && !shown.length };
}

/** What calls the person in the groups, each by its row, or by its project's label while the project is folded. */
function edgeCalls(groups: readonly GroupPage[], all: readonly ThreadSummary[]): EdgeCall[] {
  const below = subthreadStatuses(all);
  return groups.flatMap((group) => {
    const statuses = rootStatuses(group.roots, all);
    const calls = (group.open ? group.rows : group.roots).filter((root) => callsThePerson(statuses.get(root.id)));
    const anchor = (root: ThreadSummary) => (group.open ? `[data-row=${JSON.stringify(root.id)}]` : `[data-project-label=${JSON.stringify(group.project.id)}]`);
    return calls.map((root) => ({ thread: root, subthreads: below.get(root.id) ?? null, anchor: anchor(root) }));
  });
}

/**
 * What the list keeps up behind it: the keyboard's order through the rows it shows, and reading on by itself until
 * every group is whole.
 */
function useListUpkeep({ activeId, pinnedOnly, pending, limit, loadMore }: ThreadList, list: SidebarDayList, shownRoots: ThreadSummary[], children: ChildPages) {
  const collapsed = useLayout((s) => s.collapsed);
  const orderKey = JSON.stringify(threadTreeRows(shownRoots, list.all, collapsed, activeId ? [activeId] : [], children.limits).map((row) => row.thread.id));
  useEffect(() => {
    useUi.getState().setThreadOrder(JSON.parse(orderKey) as string[]);
  }, [orderKey]);
  const grows = !pinnedOnly && !pending && sidebarGroupsGrow({ end: list.end, hasMore: list.hasMore, limit });
  useEffect(() => {
    if (grows) loadMore();
  }, [grows, limit, loadMore]);
}

/**
 * The threads grouped by project, in the order projects come and the most recently active first inside each, held still while
 * the pointer or the keyboard is in the list. Pinned threads lead in a group of their own that never scrolls away,
 * snoozed ones follow the projects, and Resolved sits at the foot. A line at an edge names what calls the person past
 * it. The whole list folds under its head, which keeps Search and the filter; folded, it counts what waits on the person.
 */
function ThreadGroups({ children }: { children: ChildPages }) {
  const state = useThreadList(children);
  const { projects, activeId, pinnedOnly, pending } = state;
  const collapsed = useLayout((s) => s.collapsed);
  const now = useSidebarNow();
  const list = dayList(state, now);
  const open = !collapsed.includes(WORKSPACES_FOLD);
  const hold = useListHold();
  const shownProjects = groupProjects(projects.data, state.seen);
  const ready = !pending && !sidebarGroupsGrow({ end: list.end, hasMore: list.hasMore, limit: state.limit });
  // Under the pinned filter the groups are empty; their layout is not kept, so the list comes back as it was.
  const allGroups = useGroupPages(list, shownProjects, collapsed, { ready: ready && !pinnedOnly, held: hold.held, now });
  const { groups, everyHidden } = drawnGroups(allGroups, { pinnedOnly, hidden: useLayout((s) => s.hiddenWorkspaces) });
  const pinsOpen = sidebarSectionOpen(collapsed, "pinned", SIDEBAR_LIST);
  const pins = pinOrder(list.shown(list.pinned, pinsOpen));
  const snoozedOpen = sidebarSectionOpen(collapsed, "snoozed", SIDEBAR_LIST);
  const snoozed = list.shown(list.snoozed, snoozedOpen);
  const resolvedOpen = !pinnedOnly && sidebarSectionOpen(collapsed, "resolved", SIDEBAR_LIST);
  const resolvedShown = list.shown(list.resolved.roots, resolvedOpen);
  const named = new Map<string, RowProject>(shownProjects.map((project) => [project.id, { name: project.name }]));
  const shownRoots = [...pins, ...groups.flatMap((group) => group.rows), ...snoozed, ...resolvedShown];
  useListUpkeep(state, list, open ? shownRoots : [], children);
  const rows = (roots: ThreadSummary[], mixed = false) => (
    <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={roots} all={list.all} activeId={activeId} projects={mixed ? named : undefined} />
  );
  const toggle = (fold: string) => () => useLayout.getState().toggleCollapsed(fold);
  const waiting = waitingRoots(list.pinned, list.all) + groups.reduce((sum, group) => sum + group.waiting, 0);
  const pinned = list.pinned.length ? (
    <Section label="Pinned" count={list.pinned.length} open={pinsOpen} onToggle={toggle(sidebarFoldKey.pinned(SIDEBAR_LIST))}>
      {rows(pins, true)}
      <PinsMore state={state} list={list} open={pinsOpen} />
    </Section>
  ) : null;
  return (
    <section className="sidebar-workspaces" data-open={open || undefined} aria-label="Workspaces" {...hold.props}>
      <SidebarListHead
        label="Workspaces"
        fold={{ open, waiting, onToggle: toggle(WORKSPACES_FOLD) }}
        tools={<ListTools empty={projects.data?.length === 0} workspaces={allGroups.map((group) => group.project)} />}
      />
      <div className="conversation-browser" hidden={!open}>
        {pinnedOnly ? null : <div className="sidebar-pinned">{pinned}</div>}
        <GroupsView calls={edgeCalls(groups, list.all)} list={list}>
          <ProjectsFailed projects={projects} />
          {pinnedOnly ? pinned : null}
          {groups.map((group) => (
            <SidebarProjectGroup
              key={group.project.id}
              project={group.project}
              open={group.open}
              waiting={group.waiting}
              hidden={group.hidden}
              onToggle={toggle(sidebarFoldKey.project(group.project.id))}
              onShowMore={group.showMore}
            >
              {rows(group.rows)}
            </SidebarProjectGroup>
          ))}
          {everyHidden ? null : <ListFeedback state={state} shown={list.pinned.length + list.rest.length + list.resolved.roots.length} snoozed={list.snoozed.length} />}
          {list.snoozed.length ? (
            <Section label="Snoozed" count={list.snoozed.length} open={snoozedOpen} onToggle={toggle(sidebarFoldKey.snoozed(SIDEBAR_LIST))}>
              {rows(snoozed, true)}
            </Section>
          ) : null}
        </GroupsView>
        {pinnedOnly || everyHidden ? null : (
          <ResolvedDrawer open={resolvedOpen} holding={resolvedShown.length > 0} onToggle={toggle(sidebarFoldKey.resolved(SIDEBAR_LIST))} accepts={resolvable(list, now)}>
            {rows(resolvedShown, true)}
            {resolvedOpen ? <ResolvedFeedback list={list} pending={state.resolvedPending || pending} onShowMore={state.loadMoreResolved} /> : null}
          </ResolvedDrawer>
        )}
      </div>
    </section>
  );
}

/**
 * The part of the list that scrolls, under the lines at its edges. A thread dragged here from Resolved goes back to the
 * list.
 */
function GroupsView({ calls, list, children }: { calls: EdgeCall[]; list: SidebarDayList; children: ReactNode }) {
  const resolve = useResolveThread();
  const reopen = useThreadDrop(
    (id) => list.resolved.roots.some((root) => root.id === id),
    (id) => resolve(id, false),
  );
  const fades = useScrollEdges();
  const edges = useListEdges(calls);
  const [fadesRef, edgesRef] = [fades.ref, edges.ref];
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const unfade = fadesRef(element);
      const unedge = edgesRef(element);
      return () => {
        unfade?.();
        unedge?.();
      };
    },
    [fadesRef, edgesRef],
  );
  return (
    <div className="sidebar-list-view">
      <div
        {...fades}
        ref={ref}
        className="browser-threads scroll-edges"
        data-edge-above={edges.edges.above.length ? true : undefined}
        data-edge-below={edges.edges.below.length ? true : undefined}
        data-drop={reopen.over || undefined}
        {...reopen.props}
      >
        {children}
      </div>
      <ListEdgeLines edges={edges.edges} calls={calls} onBring={edges.bring} />
    </div>
  );
}

/** Under the pinned filter, Pinned is the whole list and reads on a page at a time. */
function PinsMore({ state, list, open }: { state: ThreadList; list: SidebarDayList; open: boolean }) {
  return open && state.pinnedOnly && list.hasMore ? <LoadMore pending={state.pending} onClick={state.loadMore} /> : null;
}

function ProjectsFailed({ projects }: { projects: ThreadList["projects"] }) {
  if (!projects.isError) return null;
  return (
    <button className="browser-empty" onClick={() => void projects.refetch()}>
      Couldn’t load projects. Retry
    </button>
  );
}

/**
 * The list head's tools: Search, the app's one search, which opens the palette over the window, then Add project and the
 * filter. With no project yet, Add project alone.
 */
function ListTools({ empty, workspaces }: { empty: boolean; workspaces: readonly GroupProject[] }) {
  const add = (
    <Tooltip label="Add project">
      <IconButton size="xs" aria-label="Add project" className="no-drag" onClick={() => useUi.getState().setImportProject(true)}>
        <FolderPlus size={16} />
      </IconButton>
    </Tooltip>
  );
  if (empty) return add;
  return (
    <>
      <Tooltip label="Search">
        <IconButton size="xs" aria-label="Search" className="no-drag" onClick={() => useUi.getState().setPalette(true)}>
          <Search size={16} />
        </IconButton>
      </Tooltip>
      {add}
      <SidebarThreadFilter workspaces={workspaces} />
    </>
  );
}

/** Which dragged threads Resolved takes: a listed thread, not a subagent's, not there already. */
function resolvable(list: SidebarDayList, now: number) {
  const byId = new Map(list.all.map((thread) => [thread.id, thread]));
  return (id: string) => {
    const thread = byId.get(id);
    return Boolean(thread) && !isSubagentThread(thread) && !threadResolved(thread!, now) && !list.resolved.roots.some((root) => root.id === id);
  };
}

/** Resolved's paging, or why it lists nothing. */
function ResolvedFeedback({ list, pending, onShowMore }: { list: SidebarDayList; pending: boolean; onShowMore: () => void }) {
  if (list.resolved.hasMore) return <LoadMore pending={pending} onClick={onShowMore} />;
  if (list.resolved.roots.length) return null;
  return <p className="browser-empty">{pending ? "Loading threads…" : "No resolved threads."}</p>;
}

function LoadMore({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <button className="browser-load-more" onClick={onClick} disabled={pending}>
      {pending ? "Loading threads…" : "Load more threads"}
    </button>
  );
}

/** A part of the list that folds under its heading. The count shows only where it is the whole of that part. */
function Section({ label, count, open, onToggle, children }: { label: string; count?: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const [animate, setAnimate] = useState(false);
  return (
    <div className="sidebar-section" data-open={open || undefined}>
      <button
        aria-expanded={open}
        onClick={() => {
          setAnimate(true);
          onToggle();
        }}
        className="sidebar-section-toggle no-drag"
      >
        <span>{label}</span>
        <ChevronRight size={12} className="sidebar-section-chevron" />
        {count !== undefined && !open ? <span className="sidebar-section-count tabular">{count}</span> : null}
      </button>
      <div className={cn("sidebar-thread-list", animate && open && "motion-stagger")}>{children}</div>
    </div>
  );
}
