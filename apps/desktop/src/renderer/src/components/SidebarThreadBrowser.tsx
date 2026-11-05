import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { WORKSPACE_ID, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout } from "../lib/layout";
import {
  type SidebarFilter,
  listedThreads,
  sidebarDayKey,
  sidebarDayOpen,
  sidebarDaySections,
  sidebarFoldKey,
  sidebarListGrows,
  SIDEBAR_LIST,
  sidebarSectionOpen,
  sidebarThreadPage,
  THREAD_PAGE,
  threadListParams,
  threadTreeActivity,
  threadTreeMatches,
  threadTreeRows,
  threadFoldIds,
  useChildThreadPages,
  cachedChildPage,
} from "@openorc/client";
import { useOrclings } from "../lib/orclings";
import { useRpc, useRpcs } from "../lib/client";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { Check, ChevronRight, Crosshair, Funnel, Pin, SlidersHorizontal } from "./icons";
import { SidebarProjectVisibility } from "./SidebarProjectVisibility";
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
      filter: listedThreads(filter),
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

/** While a longer page loads, the list keeps the last page it read of the same threads, at that page's length. */
function cachedListPage(cache: QueryClient, params: RpcParams<"threads.list">): { rows: ThreadSummary[]; limit: number } | undefined {
  const exact = cachedChildPage(cache, params);
  if (exact) return { rows: exact, limit: (params.limit ?? exact.length) - 1 };
  const key = (value: RpcParams<"threads.list">) => JSON.stringify({ ...value, childLimits: undefined, limit: undefined });
  const query = cache
    .getQueryCache()
    .findAll({ queryKey: ["threads.list"], predicate: (entry) => key(entry.queryKey[1] as RpcParams<"threads.list">) === key(params) && Array.isArray(entry.state.data) })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0];
  const rows = query?.state.data as ThreadSummary[] | undefined;
  return rows ? { rows, limit: ((query!.queryKey[1] as RpcParams<"threads.list">).limit ?? rows.length) - 1 } : undefined;
}

/** Orcmode's way out: the threads it leaves out, one click from the full list. */
function OrcModeEnd({ leftOut, more, pending, shown }: { leftOut: number; more: boolean; pending: boolean; shown: number }) {
  const setFilter = useLayout((s) => s.setSidebarFilter);
  if (pending && !shown) return <p className="browser-empty">Loading threads…</p>;
  return (
    <>
      {shown ? null : <p className="browser-empty">Nothing needs you today.</p>}
      {leftOut || more ? (
        <button className="browser-load-more" onClick={() => setFilter("active")}>
          {more ? "Show all threads" : `Show ${leftOut} more`}
        </button>
      ) : null}
    </>
  );
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

/** How far the list reads by itself to complete an open day; past it the reader asks. */
const GROWTH_LIMIT = 400;

/**
 * One list across the shown projects, newest work first. Orcmode keeps each project's working set; the other
 * filters page one list, and pinned threads come from their own read so an old pin still leads the list.
 */
function useThreadList(children: ChildPages) {
  const queryClient = useQueryClient();
  const chosen = useLayout((s) => s.sidebarFilter);
  const pinnedOnly = useLayout((s) => s.pinnedOnly);
  const [limit, setLimit] = useState(THREAD_PAGE);
  const { query: projects, visible, allHidden } = useSidebarProjects();
  const projectIds = visible.map((project) => project.id).sort();
  const homes = new Set(useOrclings().map((orcling) => orcling.threadId));
  const activeId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const active = useRpc("threads.get", { id: activeId ?? "" }, { enabled: Boolean(activeId) });
  const orc = chosen === "orc";
  const listed = { projectIds, filter: listedThreads(chosen), orderBy: "activity" as const, includeChildren: true, ...children.params() };
  const params = orc ? projectIds.map((id) => ({ ...threadListParams(id, chosen), ...children.params(id) })) : [{ ...listed, pinnedOnly, limit: limit + 1 }];
  const queries = useRpcs("threads.list", params, { enabled: Boolean(projects.data), refetchInterval: 60_000 });
  const pins = useRpc("threads.list", { ...listed, pinnedOnly: true }, { enabled: Boolean(projects.data) && chosen === "active" && !pinnedOnly, refetchInterval: 60_000 });
  const fetched = queries.map((query, index) => (query.data ? { rows: query.data, limit: orc ? THREAD_PAGE : limit } : cachedListPage(queryClient, params[index]!)));
  const family = useSelectedFamily(
    active.data,
    chosen,
    fetched.map((page) => page?.rows),
    children,
  );
  const selected = active.data && projectIds.includes(active.data.projectId) && (!pinnedOnly || active.data.pinnedAt) ? active.data : null;
  const pages = fetched.map((page, index) =>
    sidebarThreadPage({
      projectId: orc ? projectIds[index]! : (selected?.projectId ?? WORKSPACE_ID),
      fetched: withFamily(page?.rows, family, orc ? [projectIds[index]!] : projectIds),
      selected,
      filter: chosen,
      limit: page?.limit ?? limit,
      now: Date.now(),
      hidden: homes,
    }),
  );
  const pinPage = sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: pins.data, selected: null, filter: chosen, limit: Number.MAX_SAFE_INTEGER, now: Date.now(), hidden: homes });
  const pending = queries.some((query) => query.isPending);
  return {
    projects,
    queries,
    pages,
    pinPage,
    activeId,
    pinnedOnly,
    view: chosen,
    allHidden,
    pending,
    limit,
    loadMore: () => setLimit((old) => old + THREAD_PAGE),
  };
}

type ThreadList = ReturnType<typeof useThreadList>;

function ListFeedback({ state, shown, snoozed }: { state: ThreadList; shown: number; snoozed: number }) {
  const { projects, queries, pages, view, pinnedOnly, allHidden, pending } = state;
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
  if (view === "orc") return <OrcModeEnd leftOut={pages.reduce((sum, page) => sum + page.leftOut, 0)} more={hasMore} pending={pending} shown={shown} />;
  if (pending && !shown) return <p className="browser-empty">Loading threads…</p>;
  if (shown || snoozed || hasMore) return null;
  return <p className="browser-empty">{emptyMessage(pinnedOnly)}</p>;
}

const unique = (rows: readonly ThreadSummary[]) => [...new Map(rows.map((thread) => [thread.id, thread])).values()];

/**
 * The list's parts from its pages: pins first (with the pinned filter, every pin), then the rest in their days, and
 * snoozed threads apart. A folded part still shows the open thread, so the list never hides where you are.
 */
function dayList({ pages, pinPage, pinnedOnly, view, activeId }: ThreadList) {
  const hasMore = view !== "orc" && pages.some((page) => page.hasMore);
  const all = unique([...pinPage.list, ...pages.flatMap((page) => page.list)]);
  const latestFirst = (a: ThreadSummary, b: ThreadSummary) => threadTreeActivity(b, all) - threadTreeActivity(a, all) || b.id.localeCompare(a.id);
  const pinned = unique([...pinPage.pinned, ...pages.flatMap((page) => page.pinned)]).sort(latestFirst);
  const unpinned = (thread: ThreadSummary) => !pinned.some((pin) => pin.id === thread.id);
  const rest = pinnedOnly ? [] : pages.flatMap((page) => page.rest.filter(unpinned)).sort(latestFirst);
  const snoozed = pinnedOnly ? [] : pages.flatMap((page) => page.snoozed).sort(latestFirst);
  const holdsActive = (root: ThreadSummary) => Boolean(activeId) && threadTreeMatches(root, all, (row) => row.id === activeId);
  return {
    all,
    hasMore,
    pinned,
    rest,
    snoozed,
    sections: sidebarDaySections(rest, all, Date.now(), hasMore && !pinnedOnly),
    shown: (roots: ThreadSummary[], open: boolean) => (open ? roots : roots.filter(holdsActive)),
  };
}

type ListPart = { key: string; label: string; count?: number; open: boolean; fold: string; roots: ThreadSummary[]; more: boolean };

/** The parts that fold, in order: Pinned, then each day. Paging sits at the end of Pinned under the pinned filter, else of Older. */
function listParts(list: ReturnType<typeof dayList>, collapsed: readonly string[], pinnedOnly: boolean): ListPart[] {
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
    return { key: section.day, label: section.label, open, fold: sidebarDayKey(section.day), roots: list.shown(section.roots, open), more: section.day === "older" && list.hasMore };
  });
  return [...(list.pinned.length ? [pins] : []), ...days];
}

/** The threads by when they last saw work: pinned ones first, then today and yesterday open, the last week and older folded. Search reaches the rest. */
function DayThreadBrowser({ children }: { children: ChildPages }) {
  const state = useThreadList(children);
  const { projects, activeId, pinnedOnly, view, pending, limit, loadMore } = state;
  const collapsed = useLayout((s) => s.collapsed);
  const list = dayList(state);
  const parts = listParts(list, collapsed, pinnedOnly);
  const snoozedOpen = sidebarSectionOpen(collapsed, "snoozed", SIDEBAR_LIST);
  const snoozed = list.shown(list.snoozed, snoozedOpen);
  const rowProjects = new Map<string, RowProject>((projects.data ?? []).map((project) => [project.id, { name: project.name, rootPath: project.rootPath }]));
  rowProjects.set(WORKSPACE_ID, { name: "Workspace" });
  const orderKey = JSON.stringify(threadTreeRows([...parts.flatMap((part) => part.roots), ...snoozed], list.all, collapsed, activeId ? [activeId] : [], children.limits).map((row) => row.thread.id));
  useEffect(() => {
    useUi.getState().setThreadOrder(JSON.parse(orderKey) as string[]);
  }, [orderKey]);
  const grows = view !== "orc" && !pinnedOnly && !pending && limit < GROWTH_LIMIT && sidebarListGrows({ sections: list.sections, hasMore: list.hasMore, collapsed });
  useEffect(() => {
    if (grows) loadMore();
  }, [grows, limit, loadMore]);
  const rows = (roots: ThreadSummary[]) => <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={roots} all={list.all} activeId={activeId} projects={rowProjects} />;
  const toggle = (fold: string) => () => useLayout.getState().toggleCollapsed(fold);
  return (
    <section className="conversation-browser" aria-label="Thread browser">
      <div className="browser-threads">
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
        <ListFeedback state={state} shown={list.pinned.length + list.rest.length} snoozed={list.snoozed.length} />
        {list.snoozed.length ? (
          <Section label="Snoozed" count={list.snoozed.length} open={snoozedOpen} onToggle={toggle(sidebarFoldKey.snoozed(SIDEBAR_LIST))}>
            {rows(snoozed)}
          </Section>
        ) : null}
      </div>
    </section>
  );
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

const FILTER_NAMES: Record<SidebarFilter | "pinned", string> = { active: "Active threads", orc: "Orcmode", archived: "Archived threads", pinned: "Pinned threads" };

/**
 * The filter's mark: orcmode (a crosshair, for the working set it narrows to) and pins show their own, so a narrowed list
 * never looks like the whole one.
 */
function FilterMark({ selection }: { selection: SidebarFilter | "pinned" }) {
  if (selection === "orc") return <Crosshair size={16} />;
  return selection === "pinned" ? <Pin size={16} /> : <Funnel size={16} />;
}

/** The thread list's filter: orcmode, active, archived or pinned threads, which projects show, and importing terminal sessions. */
export function ThreadFilter() {
  const filter = useLayout((s) => s.sidebarFilter);
  const pinned = useLayout((s) => s.pinnedOnly);
  const setFilter = useLayout((s) => s.setSidebarFilter);
  const projectId = useLayout((s) => s.projectId);
  const hiddenProjects = useLayout((s) => s.hiddenProjects);
  const [editingProjects, setEditingProjects] = useState(false);
  const selection = pinned ? "pinned" : filter;
  const narrowed = selection !== "active" || hiddenProjects.length > 0;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <IconButton
              aria-label={`Filter threads${selection === "active" ? "" : `: ${FILTER_NAMES[selection]}`}${hiddenProjects.length ? ": projects filtered" : ""}`}
              size="lg"
              className={cn("no-drag", narrowed && "text-accent-ink")}
            />
          }
        >
          <FilterMark selection={selection} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              {(["orc", "active", "archived"] as const).map((value) => (
                <Menu.Item key={value} className={menuItem} onClick={() => setFilter(value)}>
                  <Check size={13} className={filter === value && !pinned ? "text-accent-ink" : "text-transparent"} />
                  {FILTER_NAMES[value]}
                </Menu.Item>
              ))}
              <Menu.Item className={menuItem} onClick={() => setFilter("active", !pinned)}>
                <Check size={13} className={pinned ? "text-accent-ink" : "text-transparent"} />
                Pinned threads
              </Menu.Item>
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
