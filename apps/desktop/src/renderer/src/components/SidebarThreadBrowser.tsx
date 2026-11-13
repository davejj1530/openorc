import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { useQueryClient } from "@tanstack/react-query";
import { isSubagentThread, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { ALL_WORKSPACES, focusedProject, useLayout } from "../lib/layout";
import {
  type GroupProject,
  type SidebarDayList,
  type SidebarFilter,
  cachedListPage,
  GROUP_PAGE,
  GROUP_STEP,
  groupPage,
  NEEDS_YOU_PAGE,
  projectGroups,
  cloudProjects,
  sidebarDayList,
  sidebarFoldKey,
  sidebarGroupsGrow,
  SIDEBAR_LIST,
  sidebarSectionOpen,
  sidebarThreadPage,
  THREAD_PAGE,
  threadTreeRows,
  threadFoldIds,
  resolvedBefore,
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
import { Check, ChevronRight, FolderPlus, Funnel, Pin, Search } from "./icons";
import { ResolvedDrawer, useResolveThread, useThreadDrop } from "./SidebarResolved";
import { SidebarListHead } from "./SidebarListHead";
import { SidebarProjectGroup } from "./SidebarProjectGroup";
import type { RowProject } from "./ThreadLibraryRow";
import { ThreadTreeList } from "./ThreadTreeList";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { IconButton, Tooltip } from "./ui";
import { floatingGround } from "../lib/use-anchor-ground";
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
  const resolvedCount = useRpc("threads.resolvedCount", { projectIds, quietBefore: resolvedBefore(Date.now()) }, besides);
  const fetched = queries.map((query, index) => (query.data ? { rows: query.data, limit } : cachedListPage(queryClient, params[index]!)));
  const family = useSelectedFamily(active.data, active.data?.archivedAt ? "archived" : "active", [...fetched.map((page) => page?.rows), resolved.data], children);
  const selected = active.data && projectIds.includes(active.data.projectId) && (!pinnedOnly || active.data.pinnedAt) ? active.data : null;
  const page = (rows: ThreadSummary[] | undefined, filter: SidebarFilter, shown: number) =>
    sidebarThreadPage({ projectId: selected?.projectId ?? WORKSPACE_ID, fetched: withFamily(rows, family, projectIds), selected, filter, limit: shown, now: Date.now(), hidden: homes });
  const apart = (rows: ThreadSummary[] | undefined) =>
    sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: rows, selected: null, filter: "active", limit: Number.MAX_SAFE_INTEGER, now: Date.now(), hidden: homes });
  const pages = fetched.map((fetchedPage) => page(fetchedPage?.rows, "active", fetchedPage?.limit ?? limit));
  const putRows = resolvedRows(resolvedOpen, resolved.data, selected);
  return {
    projects,
    queries,
    pages,
    pinPage: apart(pins.data),
    needsYouPage: apart(needsYou.data),
    resolvedPage: putRows && page(putRows, "archived", resolvedLimit),
    activeId,
    pinnedOnly,
    pending: queries.some((query) => query.isPending),
    resolvedPending,
    resolvedCount: resolvedCount.data,
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
 * Each project's group as the list shows it: open or folded by the reader, and paged. Every project has one, an empty
 * one too, but the Workspace only while it holds threads.
 */
function useGroupPages(list: SidebarDayList, projects: readonly GroupProject[], collapsed: readonly string[]) {
  const [shown, setShown] = useState<Readonly<Record<string, number>>>({});
  const holding = new Set(list.shown(list.rest, false).map((root) => root.id));
  const holdsActive = (root: ThreadSummary) => holding.has(root.id);
  return projectGroups(projects, list.rest, list.all)
    .filter((group) => group.project.id !== WORKSPACE_ID || group.roots.length)
    .map((group) => {
      const id = group.project.id;
      const open = sidebarSectionOpen(collapsed, "project", id);
      const limit = shown[id] ?? GROUP_PAGE;
      return { ...group, open, ...groupPage(group.roots, { open, shown: limit, holdsActive }), showMore: () => setShown((old) => ({ ...old, [id]: limit + GROUP_STEP })) };
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
 * The threads grouped by project, in the order projects come and newest work first inside each. Pinned threads lead in
 * a group of their own, snoozed ones follow the projects, and Resolved sits at the foot. The whole list folds under its
 * head, which keeps Search and the filter; folded, it counts what waits on the person.
 */
function ThreadGroups({ children }: { children: ChildPages }) {
  const state = useThreadList(children);
  const { projects, activeId, pinnedOnly, pending, loadMore } = state;
  const collapsed = useLayout((s) => s.collapsed);
  const now = useSidebarNow();
  const list = dayList(state, now);
  const open = !collapsed.includes(WORKSPACES_FOLD);
  const shownProjects = groupProjects(projects.data, list.all);
  const allGroups = useGroupPages(list, shownProjects, collapsed);
  const groups = pinnedOnly ? [] : allGroups;
  const pinsOpen = sidebarSectionOpen(collapsed, "pinned", SIDEBAR_LIST);
  const pins = list.shown(list.pinned, pinsOpen);
  const snoozedOpen = sidebarSectionOpen(collapsed, "snoozed", SIDEBAR_LIST);
  const snoozed = list.shown(list.snoozed, snoozedOpen);
  const resolvedOpen = !pinnedOnly && sidebarSectionOpen(collapsed, "resolved", SIDEBAR_LIST);
  const resolvedIds = new Set(list.resolved.roots.map((root) => root.id));
  const resolvedShown = list.shown(list.resolved.roots, resolvedOpen);
  const resolve = useResolveThread();
  const reopen = useThreadDrop(
    (id) => resolvedIds.has(id),
    (id) => resolve(id, false),
  );
  const named = new Map<string, RowProject>(shownProjects.map((project) => [project.id, { name: project.name }]));
  const shownRoots = [...pins, ...groups.flatMap((group) => group.rows), ...snoozed, ...resolvedShown];
  useListUpkeep(state, list, open ? shownRoots : [], children);
  const rows = (roots: ThreadSummary[], mixed = false) => (
    <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={roots} all={list.all} activeId={activeId} projects={mixed ? named : undefined} />
  );
  const toggle = (fold: string) => () => useLayout.getState().toggleCollapsed(fold);
  const edges = useScrollEdges();
  const waiting = waitingRoots(list.pinned, list.all) + groups.reduce((sum, group) => sum + group.waiting, 0);
  return (
    <section className="sidebar-workspaces" data-open={open || undefined} aria-label="Workspaces">
      <SidebarListHead label="Workspaces" fold={{ open, waiting, onToggle: toggle(WORKSPACES_FOLD) }} tools={<ListTools />} />
      <div className="conversation-browser" hidden={!open}>
        <div {...edges} className="browser-threads scroll-edges" data-drop={reopen.over || undefined} {...reopen.props}>
          <ProjectsFailed projects={projects} />
          {list.pinned.length ? (
            <Section label="Pinned" count={list.pinned.length} open={pinsOpen} onToggle={toggle(sidebarFoldKey.pinned(SIDEBAR_LIST))}>
              {rows(pins, true)}
              {pinsOpen && pinnedOnly && list.hasMore ? <LoadMore pending={pending} onClick={loadMore} /> : null}
            </Section>
          ) : null}
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
          <ListFeedback state={state} shown={list.pinned.length + list.rest.length + list.resolved.roots.length} snoozed={list.snoozed.length} />
          {list.snoozed.length ? (
            <Section label="Snoozed" count={list.snoozed.length} open={snoozedOpen} onToggle={toggle(sidebarFoldKey.snoozed(SIDEBAR_LIST))}>
              {rows(snoozed, true)}
            </Section>
          ) : null}
        </div>
        {pinnedOnly ? null : (
          <ResolvedDrawer open={resolvedOpen} holding={resolvedShown.length > 0} count={state.resolvedCount} onToggle={toggle(sidebarFoldKey.resolved(SIDEBAR_LIST))} accepts={resolvable(list, now)}>
            {rows(resolvedShown, true)}
            {resolvedOpen ? <ResolvedFeedback list={list} pending={state.resolvedPending || pending} onShowMore={state.loadMoreResolved} /> : null}
          </ResolvedDrawer>
        )}
      </div>
    </section>
  );
}

function ProjectsFailed({ projects }: { projects: ThreadList["projects"] }) {
  if (!projects.isError) return null;
  return (
    <button className="browser-empty" onClick={() => void projects.refetch()}>
      Couldn’t load projects. Retry
    </button>
  );
}

/** The list head's tools: Search, the app's one search, which opens the palette over the window, then Add project and the filter. */
function ListTools() {
  return (
    <>
      <Tooltip label="Search">
        <IconButton size="lg" aria-label="Search" className="no-drag" onClick={() => useUi.getState().setPalette(true)}>
          <Search size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Add project">
        <IconButton size="lg" aria-label="Add project" className="no-drag" onClick={() => useUi.getState().setImportProject(true)}>
          <FolderPlus size={16} />
        </IconButton>
      </Tooltip>
      <ThreadFilter />
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

/** The thread list's filter: every thread or the pinned ones, and importing terminal sessions. */
function ThreadFilter() {
  const pinned = useLayout((s) => s.pinnedOnly);
  const setPinnedOnly = useLayout((s) => s.setPinnedOnly);
  const projectId = useLayout(focusedProject);
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={`Filter threads${pinned ? ": Pinned threads" : ""}`} size="lg" className={cn("no-drag", pinned && "text-accent-ink")} />}>
        {/* Pins show their own mark, so the pinned list never looks like the whole one. */}
        {pinned ? <Pin size={16} /> : <Funnel size={16} />}
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {[false, true].map((value) => (
              <Menu.Item key={String(value)} className={menuItem} onClick={() => setPinnedOnly(value)}>
                <Check size={13} className={pinned === value ? "text-accent-ink" : "text-transparent"} />
                {value ? "Pinned threads" : "All threads"}
              </Menu.Item>
            ))}
            <Menu.Separator className={menuSeparator} />
            <Menu.Item className={menuItem} onClick={() => useUi.getState().setImportSessions(true, projectId ?? undefined)}>
              Import terminal sessions…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
