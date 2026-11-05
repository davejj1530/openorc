import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { useQueryClient } from "@tanstack/react-query";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout } from "../lib/layout";
import {
  type SidebarFilter,
  type SidebarFold,
  listedThreads,
  projectMeta,
  sidebarFoldKey,
  sidebarSectionOpen,
  sidebarThreadPage,
  THREAD_PAGE,
  threadListParams,
  visibleSidebarThreadIds,
  threadTreeActivity,
  threadFoldIds,
  useChildThreadPages,
  cachedChildPage,
} from "@openorc/client";
import { useOrclings } from "../lib/orclings";
import { useRpc, useRpcs } from "../lib/client";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { Check, ChevronDown, ChevronRight, Crosshair, Funnel, Pin, SlidersHorizontal } from "./icons";
import { SidebarProjectGroup } from "./SidebarProjectGroup";
import { SidebarProjectVisibility } from "./SidebarProjectVisibility";
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

/** Loading an off-page selection must not replace the project's stable page query. */
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

/** Each project owns a page. The task/new-thread scope never hides another project's work. */
function useThreadGroups(children: ChildPages) {
  const queryClient = useQueryClient();
  const chosen = useLayout((s) => s.sidebarFilter);
  const pinnedOnly = useLayout((s) => s.pinnedOnly);
  const filter = listedThreads(chosen);
  const collapsed = useLayout((s) => s.collapsed);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const { query: projects, visible: groups, allHidden } = useSidebarProjects();
  const orclings = useOrclings();
  const homes = new Set(orclings.map((orcling) => orcling.threadId));
  const activeId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const active = useRpc("threads.get", { id: activeId ?? "" }, { enabled: Boolean(activeId) });
  const activeProject = activeId && !homes.has(activeId) && groups.some((group) => group.id === active.data?.projectId) ? active.data?.projectId : undefined;
  const params = groups.map((group) => ({ ...threadListParams(group.id, chosen, limits[`${filter}:${group.id}`]), ...children.params(group.id) }));
  const queries = useRpcs("threads.list", params, { refetchInterval: 60_000 });
  const pages = queries.map((query, index) => query.data ?? cachedChildPage(queryClient, params[index]!));
  const family = useSelectedFamily(active.data, chosen, pages, children);
  useEffect(() => {
    if (!activeProject) return;
    const layout = useLayout.getState();
    if (!sidebarSectionOpen(layout.collapsed, "project", activeProject)) layout.toggleCollapsed(sidebarFoldKey.project(activeProject));
  }, [activeId, activeProject]);
  const visible = groups.map((group, index) => {
    const query = queries[index]!;
    const page = sidebarThreadPage({
      projectId: group.id,
      fetched: withFamily(pages[index], family, [group.id]),
      selected: active.data,
      filter: chosen,
      limit: limits[`${filter}:${group.id}`] ?? THREAD_PAGE,
      now: Date.now(),
      hidden: homes,
    });
    return { ...group, query, ...page, rest: pinnedOnly ? [] : page.rest, snoozed: pinnedOnly ? [] : page.snoozed };
  });
  const orderKey = JSON.stringify(visibleSidebarThreadIds(visible, collapsed, null, activeId ? [activeId] : [], children.limits));
  useEffect(() => {
    useUi.getState().setThreadOrder(JSON.parse(orderKey) as string[]);
  }, [orderKey]);
  const loadMore = (id: string) => setLimits((old) => ({ ...old, [`${filter}:${id}`]: (old[`${filter}:${id}`] ?? THREAD_PAGE) + THREAD_PAGE }));
  return { visible, activeId, loadMore, projects, allHidden, orc: chosen === "orc", pinnedOnly };
}

type ThreadGroup = ReturnType<typeof useThreadGroups>["visible"][number];

/** Orcmode lists only the projects with something in its working set, or with threads that failed to load. */
function orcGroups(groups: ThreadGroup[]): ThreadGroup[] {
  return groups.filter((group) => group.query.isError || group.pinned.length > 0 || group.rest.length > 0);
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

/** The project list stays mounted across app destinations, keeping filters and loaded pages. */
export function SidebarThreadBrowser() {
  const children = useChildThreadPages();
  const ungrouped = useLayout((s) => s.ungroupByProjects);
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
  return ungrouped ? <FlatThreadBrowser children={children} /> : <GroupedThreadBrowser children={children} />;
}

function GroupedThreadBrowser({ children }: { children: ChildPages }) {
  const { visible, activeId, loadMore, projects, allHidden, orc, pinnedOnly } = useThreadGroups(children);
  const shown = orc ? orcGroups(visible) : visible;
  return (
    <section className="conversation-browser" aria-label="Thread browser">
      <div className="browser-threads">
        {projects.isError ? (
          <button className="browser-empty" onClick={() => void projects.refetch()}>
            Couldn’t load projects. Retry
          </button>
        ) : null}
        {allHidden ? <p className="browser-empty">All projects are hidden.</p> : null}
        {shown.map((group) => (
          <SidebarProjectGroup key={group.id} id={group.id} name={group.name} rootPath={group.rootPath} meta={projectMeta(group.list, { loaded: group.query.isSuccess, more: group.hasMore })}>
            {group.pinned.length > 0 ? (
              <Section fold="pinned" projectId={group.id} label="Pinned" count={group.pinned.length}>
                <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={group.pinned} all={group.list} activeId={activeId} />
              </Section>
            ) : null}
            <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={group.rest} all={group.list} activeId={activeId} />
            {group.query.isPending ? <p className="browser-empty">Loading threads…</p> : null}
            {group.query.isError ? (
              <button className="browser-empty" onClick={() => void group.query.refetch()}>
                Couldn’t load threads. Retry
              </button>
            ) : null}
            {group.query.isSuccess && !group.pinned.length && !group.rest.length && !group.snoozed.length ? <p className="browser-empty">{emptyMessage(pinnedOnly)}</p> : null}
            {group.hasMore && !orc ? (
              <button className="browser-load-more" onClick={() => loadMore(group.id)}>
                Load more threads
              </button>
            ) : null}
            {group.snoozed.length > 0 ? (
              <Section fold="snoozed" projectId={group.id} label="Snoozed" count={group.snoozed.length}>
                <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={group.snoozed} all={group.list} activeId={activeId} />
              </Section>
            ) : null}
          </SidebarProjectGroup>
        ))}
        {orc && !allHidden ? (
          <OrcModeEnd
            leftOut={visible.reduce((sum, group) => sum + group.leftOut, 0)}
            more={visible.some((group) => group.hasMore)}
            pending={visible.some((group) => group.query.isPending)}
            shown={shown.length}
          />
        ) : null}
      </div>
    </section>
  );
}

const UNGROUPED_LIST = "ungrouped";

/** Orcmode keeps each project's working set; other filters page one list across projects. */
function useFlatThreadPages(children: ChildPages) {
  const queryClient = useQueryClient();
  const chosen = useLayout((s) => s.sidebarFilter);
  const pinnedOnly = useLayout((s) => s.pinnedOnly);
  const collapsed = useLayout((s) => s.collapsed);
  const [limit, setLimit] = useState(THREAD_PAGE);
  const { query: projects, visible, allHidden } = useSidebarProjects();
  const projectIds = visible.map((project) => project.id).sort();
  const homes = new Set(useOrclings().map((orcling) => orcling.threadId));
  const activeId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const active = useRpc("threads.get", { id: activeId ?? "" }, { enabled: Boolean(activeId) });
  const params =
    chosen === "orc"
      ? projectIds.map((id) => ({ ...threadListParams(id, chosen), ...children.params(id) }))
      : [
          {
            projectIds,
            filter: listedThreads(chosen),
            orderBy: "activity" as const,
            pinnedOnly,
            limit: limit + 1,
            includeChildren: true,
            ...children.params(),
          },
        ];
  const queries = useRpcs("threads.list", params, { enabled: Boolean(projects.data), refetchInterval: 60_000 });
  const fetched = queries.map((query, index) => query.data ?? cachedChildPage(queryClient, params[index]!));
  const family = useSelectedFamily(active.data, chosen, fetched, children);
  const selected = active.data && projectIds.includes(active.data.projectId) && (!pinnedOnly || active.data.pinnedAt) ? active.data : null;
  const pages = fetched.map((page, index) =>
    sidebarThreadPage({
      projectId: chosen === "orc" ? projectIds[index]! : (selected?.projectId ?? WORKSPACE_ID),
      fetched: withFamily(page, family, chosen === "orc" ? [projectIds[index]!] : projectIds),
      selected,
      filter: chosen,
      limit: chosen === "orc" ? THREAD_PAGE : limit,
      now: Date.now(),
      hidden: homes,
    }),
  );
  return { projects, queries, pages, activeId, pinnedOnly, view: chosen, collapsed, allHidden, loadMore: () => setLimit((old) => old + THREAD_PAGE) };
}

function FlatThreadFeedback({ state, shown, snoozed }: { state: ReturnType<typeof useFlatThreadPages>; shown: number; snoozed: number }) {
  const { projects, queries, pages, view, pinnedOnly, allHidden } = state;
  if (projects.isError) return null;
  if (allHidden) return <p className="browser-empty">All projects are hidden.</p>;
  const hasMore = pages.some((page) => page.hasMore);
  const pending = queries.some((query) => query.isPending);
  const failed = queries.filter((query) => query.isError);
  if (failed.length)
    return (
      <button className="browser-empty" onClick={() => failed.forEach((query) => void query.refetch())}>
        Couldn’t load threads. Retry
      </button>
    );
  if (view === "orc") return <OrcModeEnd leftOut={pages.reduce((sum, page) => sum + page.leftOut, 0)} more={hasMore} pending={pending} shown={shown} />;
  if (pending) return <p className="browser-empty">Loading threads…</p>;
  if (shown || snoozed || hasMore) return null;
  return <p className="browser-empty">{emptyMessage(pinnedOnly)}</p>;
}

/** One list across projects, ordered by recent activity rather than project or pin priority. */
function FlatThreadBrowser({ children }: { children: ChildPages }) {
  const state = useFlatThreadPages(children);
  const { projects, pages, activeId, pinnedOnly, view, collapsed, loadMore } = state;
  const projectNames = new Map((projects.data ?? []).map((project) => [project.id, project.name]));
  projectNames.set(WORKSPACE_ID, "Workspace");
  const hasMore = pages.some((page) => page.hasMore);
  const all = pages.flatMap((page) => page.list);
  const latestFirst = (a: ThreadSummary, b: ThreadSummary) => threadTreeActivity(b, all) - threadTreeActivity(a, all) || b.id.localeCompare(a.id);
  const rows = pages.flatMap((page) => [...page.pinned, ...(pinnedOnly ? [] : page.rest)]).sort(latestFirst);
  const snoozed = pinnedOnly ? [] : pages.flatMap((page) => page.snoozed).sort(latestFirst);
  const order = visibleSidebarThreadIds([{ id: UNGROUPED_LIST, list: all, pinned: [], rest: rows, snoozed }], collapsed, UNGROUPED_LIST, activeId ? [activeId] : [], children.limits);
  useEffect(() => {
    useUi.getState().setThreadOrder(order);
  }, [order]);
  return (
    <section className="conversation-browser" aria-label="Thread browser">
      <div className="browser-threads">
        {projects.isError ? (
          <button className="browser-empty" onClick={() => void projects.refetch()}>
            Couldn’t load projects. Retry
          </button>
        ) : null}
        <div className="sidebar-thread-list">
          <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={rows} all={all} activeId={activeId} projectNames={projectNames} />
        </div>
        <FlatThreadFeedback state={state} shown={rows.length} snoozed={snoozed.length} />
        {hasMore && view !== "orc" ? (
          <button className="browser-load-more" onClick={loadMore}>
            Load more threads
          </button>
        ) : null}
        {snoozed.length ? (
          <Section fold="snoozed" projectId={UNGROUPED_LIST} label="Snoozed" count={snoozed.length}>
            <ThreadTreeList childLimits={children.limits} onShowMore={children.showMore} roots={snoozed} all={all} activeId={activeId} projectNames={projectNames} />
          </Section>
        ) : null}
      </div>
    </section>
  );
}

function Section({ fold, projectId, label, count, children }: { fold: SidebarFold; projectId: string; label: string; count: number; children: ReactNode }) {
  const collapsed = useLayout((s) => s.collapsed);
  const toggle = useLayout((s) => s.toggleCollapsed);
  const open = sidebarSectionOpen(collapsed, fold, projectId);
  return (
    <div>
      <button aria-expanded={open} onClick={() => toggle(sidebarFoldKey[fold](projectId))} className="sidebar-section-toggle no-drag">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{label}</span>
        <span className="tabular">{count}</span>
      </button>
      {open ? <div className="sidebar-thread-list">{children}</div> : null}
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

/** The thread list's filter: orcmode, active, archived or pinned threads, and importing terminal sessions. */
export function ThreadFilter() {
  const filter = useLayout((s) => s.sidebarFilter);
  const pinned = useLayout((s) => s.pinnedOnly);
  const setFilter = useLayout((s) => s.setSidebarFilter);
  const projectId = useLayout((s) => s.projectId);
  const ungrouped = useLayout((s) => s.ungroupByProjects);
  const setUngrouped = useLayout((s) => s.setUngroupByProjects);
  const hiddenProjects = useLayout((s) => s.hiddenProjects);
  const [editingProjects, setEditingProjects] = useState(false);
  const selection = pinned ? "pinned" : filter;
  const narrowed = selection !== "active" || ungrouped || hiddenProjects.length > 0;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <IconButton
              aria-label={`Filter threads${selection === "active" ? "" : `: ${FILTER_NAMES[selection]}`}${ungrouped ? ": ungrouped by projects" : ""}${hiddenProjects.length ? ": projects filtered" : ""}`}
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
              <Menu.CheckboxItem className={menuItem} checked={ungrouped} onCheckedChange={setUngrouped}>
                <Check size={13} className={ungrouped ? "text-accent-ink" : "text-transparent"} />
                Ungroup by projects
              </Menu.CheckboxItem>
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
