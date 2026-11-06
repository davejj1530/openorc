import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { useQueryClient } from "@tanstack/react-query";
import { isSubagentThread, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout } from "../lib/layout";
import {
  type SidebarDayList,
  type SidebarFilter,
  cachedListPage,
  NEEDS_YOU_PAGE,
  sidebarDayKey,
  sidebarDayList,
  sidebarDayOpen,
  sidebarFoldKey,
  sidebarListGrows,
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
} from "@openorc/client";
import { useOrclings } from "../lib/orclings";
import { useRpc, useRpcs } from "../lib/client";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { Check, ChevronRight, Funnel, Pin, SlidersHorizontal } from "./icons";
import { SidebarProjectVisibility } from "./SidebarProjectVisibility";
import { ResolvedDrawer, useResolveThread, useThreadDrop } from "./SidebarResolved";
import type { RowProject } from "./ThreadLibraryRow";
import { ThreadTreeList } from "./ThreadTreeList";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { IconButton } from "./ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { cn } from "../lib/cn";

function emptyMessage(pinned: boolean): string {
  return pinned ? "No pinned threads." : "No threads yet.";
}

function useSidebarProjects() {
  const projects = useRpc("projects.list", {});
  const hidden = useLayout((s) => s.hiddenProjects);
  const visible = [{ id: WORKSPACE_ID, name: "Workspace", rootPath: undefined }, ...(projects.data ?? [])].filter((project) => !hidden.includes(project.id));
  useEffect(() => {
    if (!projects.data) return;
    const { projectId, setProject } = useLayout.getState();
    if (projectId && projectId !== WORKSPACE_ID && !projects.data.some((p) => p.id === projectId)) setProject(WORKSPACE_ID);
  }, [projects.data]);
  return { query: projects, visible, allHidden: Boolean(projects.data) && visible.length === 0 };
}

/** Loading an off-page selection must not replace the list's stable page query. */
type ChildPages = ReturnType<typeof useChildThreadPages>;

function useSelectedFamily(selected: ThreadSummary | null | undefined, filter: SidebarFilter, pages: readonly (readonly ThreadSummary[] | undefined)[], children: ChildPages) {
  return useRpc(
    "threads.list",
    {
      projectId: selected?.projectId,
      filter,
      includeChildren: true,
      limit: 1,
      selectedId: selected?.id,
      ...children.params(selected?.projectId),
    },
    {
      enabled: Boolean(selected && !pages.some((page) => page?.some((thread) => thread.id === selected.id))),
    },
  ).data;
}

function withFamily(page: ThreadSummary[] | undefined, family: ThreadSummary[] | undefined, projectIds: readonly string[]): ThreadSummary[] | undefined {
  if (!page) return page;
  return [...new Map([...page, ...(family ?? []).filter((thread) => projectIds.includes(thread.projectId))].map((thread) => [thread.id, thread])).values()];
}

/** The list keeps its filters and loaded pages across app destinations. */
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
  return <DayThreadBrowser children={children} />;
}

/**
 * One list across the shown projects, newest work first, read a page at a time. Pinned threads come from their own
 * read so an old pin still leads the list, and so do the threads that need you, so a folded day can still show them.
 */
function useThreadList(children: ChildPages) {
  const queryClient = useQueryClient();
  const pinnedOnly = useLayout((s) => s.pinnedOnly);
  const resolvedOpen = useLayout((s) => sidebarSectionOpen(s.collapsed, "resolved", SIDEBAR_LIST));
  const [limit, setLimit] = useState(THREAD_PAGE);
  const [resolvedLimit, setResolvedLimit] = useState(THREAD_PAGE);
  const { query: projects, visible, allHidden } = useSidebarProjects();
  const projectIds = visible.map((project) => project.id).sort();
  const homes = new Set(useOrclings().map((orcling) => orcling.threadId));
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
    allHidden,
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
  const { projects, queries, pages, pinnedOnly, allHidden, pending } = state;
  if (projects.isError) return null;
  if (allHidden) return <p className="browser-empty">All projects are hidden.</p>;
  const hasMore = pages.some((page) => page.hasMore);
  const failed = queries.filter((query) => query.isError);
  if (failed.length)
    return (
      <button className="browser-empty" onClick={() => failed.forEach((query) => void query.refetch())}>
        Couldn’t load threads. Retry
      </button>
    );
  if (pending && !shown) return <p className="browser-empty">Loading threads…</p>;
  if (shown || snoozed || hasMore) return null;
  return <p className="browser-empty">{emptyMessage(pinnedOnly)}</p>;
}

/** The list's parts from its pages: pins first, then the rest in their days, snoozed threads apart. */
function dayList({ pages, pinPage, needsYouPage, resolvedPage, pinnedOnly, activeId }: ThreadList, now: number) {
  return sidebarDayList({ pages, pins: pinPage, needsYou: needsYouPage, resolved: resolvedPage, pinnedOnly, activeId, now });
}

type ListPart = { key: string; label: string; count?: number; open: boolean; fold: string; roots: ThreadSummary[]; more: boolean };

/** The parts that fold, in order: Pinned, then each day. Paging sits at the end of Pinned under the pinned filter, else in Resolved. */
function listParts(list: SidebarDayList, collapsed: readonly string[], pinnedOnly: boolean): ListPart[] {
  const pinsOpen = sidebarSectionOpen(collapsed, "pinned", SIDEBAR_LIST);
  const pins: ListPart = {
    key: "pinned",
    label: "Pinned",
    count: list.pinned.length,
    open: pinsOpen,
    fold: sidebarFoldKey.pinned(SIDEBAR_LIST),
    roots: list.shown(list.pinned, pinsOpen),
    more: pinnedOnly && list.hasMore,
  };
  const days = list.sections.map((section) => {
    const open = sidebarDayOpen(collapsed, section.day);
    return { key: section.day, label: section.label, open, fold: sidebarDayKey(section.day), roots: list.shownInDay(section.roots, open), more: false };
  });
  return [...(list.pinned.length ? [pins] : []), ...days];
}

/** The threads by when they last saw work: pinned ones first, then the last hours and today open, earlier days folded. Search reaches the rest. */
function DayThreadBrowser({ children }: { children: ChildPages }) {
  const state = useThreadList(children);
  const { projects, activeId, pinnedOnly, pending, limit, loadMore } = state;
  const collapsed = useLayout((s) => s.collapsed);
  const now = useSidebarNow();
  const list = dayList(state, now);
  const parts = listParts(list, collapsed, pinnedOnly);
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
  const rowProjects = new Map<string, RowProject>((projects.data ?? []).map((project) => [project.id, { name: project.name, rootPath: project.rootPath }]));
  rowProjects.set(WORKSPACE_ID, { name: "Workspace" });
  const shownRoots = [...parts.flatMap((part) => part.roots), ...snoozed, ...resolvedShown];
  const orderKey = JSON.stringify(threadTreeRows(shownRoots, list.all, collapsed, activeId ? [activeId] : [], children.limits).map((row) => row.thread.id));
  useEffect(() => {
    useUi.getState().setThreadOrder(JSON.parse(orderKey) as string[]);
  }, [orderKey]);
  const grows = !pinnedOnly && !pending && sidebarListGrows({ end: list.end, hasMore: list.hasMore, collapsed, limit });
  useEffect(() => {
    if (grows) loadMore();
  }, [grows, limit, loadMore]);
  const rows = (roots: ThreadSummary[]) => <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={roots} all={list.all} activeId={activeId} projects={rowProjects} />;
  const toggle = (fold: string) => () => useLayout.getState().toggleCollapsed(fold);
  return (
    <section className="conversation-browser" aria-label="Thread browser">
      <div className="browser-threads" data-drop={reopen.over || undefined} {...reopen.props}>
        {projects.isError ? (
          <button className="browser-empty" onClick={() => void projects.refetch()}>
            Couldn’t load projects. Retry
          </button>
        ) : null}
        {parts.map((part) => (
          <Section key={part.key} label={part.label} count={part.count} open={part.open} onToggle={toggle(part.fold)}>
            {rows(part.roots)}
            {part.open && part.more ? <LoadMore pending={pending} onClick={loadMore} /> : null}
          </Section>
        ))}
        <ListFeedback state={state} shown={list.pinned.length + list.rest.length + list.resolved.roots.length} snoozed={list.snoozed.length} />
        {list.snoozed.length ? (
          <Section label="Snoozed" count={list.snoozed.length} open={snoozedOpen} onToggle={toggle(sidebarFoldKey.snoozed(SIDEBAR_LIST))}>
            {rows(snoozed)}
          </Section>
        ) : null}
      </div>
      {pinnedOnly ? null : (
        <ResolvedDrawer open={resolvedOpen} onToggle={toggle(sidebarFoldKey.resolved(SIDEBAR_LIST))} accepts={resolvable(list, now)} holding={resolvedShown.length > 0}>
          {rows(resolvedShown)}
          {resolvedOpen ? <ResolvedFeedback list={list} pending={state.resolvedPending || pending} onShowMore={state.loadMoreResolved} /> : null}
        </ResolvedDrawer>
      )}
    </section>
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

/** The thread list's filter: every thread or the pinned ones, which projects show, and importing terminal sessions. */
export function ThreadFilter() {
  const pinned = useLayout((s) => s.pinnedOnly);
  const setPinnedOnly = useLayout((s) => s.setPinnedOnly);
  const projectId = useLayout((s) => s.projectId);
  const hiddenProjects = useLayout((s) => s.hiddenProjects);
  const [editingProjects, setEditingProjects] = useState(false);
  const narrowed = pinned || hiddenProjects.length > 0;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <IconButton
              aria-label={`Filter threads${pinned ? ": Pinned threads" : ""}${hiddenProjects.length ? ": projects filtered" : ""}`}
              size="lg"
              className={cn("no-drag", narrowed && "text-accent-ink")}
            />
          }
        >
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
              <Menu.Item className={menuItem} onClick={() => setEditingProjects(true)}>
                <SlidersHorizontal size={13} className="text-ink-4" />
                Edit projects
              </Menu.Item>
              <Menu.Separator className={menuSeparator} />
              <Menu.Item className={menuItem} onClick={() => useUi.getState().setImportSessions(true, projectId ?? undefined)}>
                Import terminal sessions…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <SidebarProjectVisibility open={editingProjects} onOpenChange={setEditingProjects} />
    </>
  );
}
