import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { Menu } from "@base-ui/react/menu";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, Inbox, ListFilter, PanelLeft, PenSquare, Search } from "./icons";
import { useEffect, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { core } from "../lib/rpc";
import { tagsFor, useRpc } from "../lib/query";
import { ResizeHandle } from "./ResizeHandle";
import { menuItem, menuPopup } from "./ThreadActions";
import { IconButton, Tooltip } from "./ui";
import { useLayout, type SidebarFilter } from "../lib/layout";
import { newThread, useRouter } from "../lib/router";
import { usePendingApprovals } from "../lib/transcript";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useUi } from "../lib/ui";
import { CoversPreview } from "../lib/browser-preview";
import { sidebarThreadPage, visibleSidebarThreadIds } from "../lib/sidebar-thread-groups";
import { useProjectIconChanges } from "../lib/project-icons";
import { WorkspaceRail } from "./WorkspaceRail";
import { ProjectPicker } from "./ProjectPicker";
import { ThreadRow } from "./ThreadLibraryRow";
import { SidebarOrclings } from "./SidebarOrclings";
import { useOrclings } from "../lib/orclings";
import { useOrclingsRail } from "../lib/orclings-rail";
import { cn } from "../lib/cn";

const PAGE = 12;

function emptyBrowserMessage(search: string, pinnedOnly: boolean): string {
  if (search) return "No matching threads in this page.";
  return pinnedOnly ? "No pinned threads." : "No threads here yet.";
}

/** A folding group of rows. Snoozed threads start folded; the layout store remembers what the user opened. */
function Section({ id, label, count, children, defaultCollapsed = false }: { id: string; label: string; count: number; children: ReactNode; defaultCollapsed?: boolean }) {
  const collapsed = useLayout((s) => s.collapsed);
  const toggle = useLayout((s) => s.toggleCollapsed);
  const open = defaultCollapsed ? collapsed.includes(id) : !collapsed.includes(id);
  return (
    <div className="mb-1">
      <button aria-expanded={open} onClick={() => toggle(id)} className="w-full flex items-center gap-1 h-6 pl-2 pr-2 text-xs text-ink-3 hover:text-ink">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="font-medium">{label}</span>
        <span className="text-ink-4 tabular">{count}</span>
      </button>
      {open ? <div className="grid grid-cols-1 min-w-0 gap-px">{children}</div> : null}
    </div>
  );
}

export function Sidebar() {
  useProjectIconChanges();
  const route = useRouter((s) => s.route);
  const open = useLayout((s) => s.sidebarOpen);
  const projectId = useLayout((s) => s.projectId);
  const setProject = useLayout((s) => s.setProject);
  const filter = useLayout((s) => s.sidebarFilter);
  const setFilter = useLayout((s) => s.setSidebarFilter);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const collapsed = useLayout((s) => s.collapsed);
  const [search, setSearch] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const orclings = useOrclings();
  const companionNavigation = useOrclingsRail(route, orclings);
  const homes = new Set(orclings.map((orcling) => orcling.threadId));
  const browsing = route.view === "thread" || route.view === "newthread" || companionNavigation.active;
  const projects = useRpc("projects.list", {});
  const projectList = projects.data ?? [];
  const groups = [{ id: WORKSPACE_ID, name: "Workspace" }, ...projectList];
  // Each group owns a page so a busy repository cannot crowd out another project.
  const threadQueries = useQueries({
    queries: groups.map((group) => {
      const params = { projectId: group.id, filter, limit: (limits[`${filter}:${group.id}`] ?? PAGE) + 1 };
      return {
        queryKey: ["threads.list", params],
        queryFn: () => core.call("threads.list", params),
        meta: { tags: tagsFor("threads.list", params) },
        refetchInterval: 60_000,
      };
    }),
  });
  const project = projectList.find((p) => p.id === projectId);
  const activeId = route.view === "thread" ? route.threadId : null;
  const activeThread = useRpc("threads.get", { id: activeId ?? "" }, { enabled: !!activeId });
  const activeProjectId = activeId && !homes.has(activeId) ? activeThread.data?.projectId : undefined;
  useEffect(() => {
    if (!activeProjectId) return;
    const layout = useLayout.getState();
    const key = `project:${activeProjectId}`;
    if (layout.collapsed.includes(key)) layout.toggleCollapsed(key);
  }, [activeId, activeProjectId]);
  // Keep the navigation scope valid when a project is removed.
  useEffect(() => {
    if (!projects.data) return;
    const known = projectId === WORKSPACE_ID || (projectId && projects.data.some((p) => p.id === projectId));
    if (!known && projectId) setProject(WORKSPACE_ID);
  }, [projects.data, projectId, setProject]);

  const now = Date.now();
  const sections = groups.map((group, index) => {
    const query = threadQueries[index]!;
    const limit = limits[`${filter}:${group.id}`] ?? PAGE;
    const page = sidebarThreadPage({ projectId: group.id, fetched: query.data, selected: activeThread.data, filter, limit, now, hidden: homes });
    return { ...group, query, ...page };
  });
  const visible = sections
    .filter((group) => projectId === null || group.id === projectId)
    .map((group) => ({
      ...group,
      pinned: group.pinned.filter((thread) => thread.title.toLowerCase().includes(search.toLowerCase())),
      rest: pinnedOnly ? [] : group.rest.filter((thread) => thread.title.toLowerCase().includes(search.toLowerCase())),
      snoozed: pinnedOnly ? [] : group.snoozed.filter((thread) => thread.title.toLowerCase().includes(search.toLowerCase())),
    }))
    .filter((group) => projectId !== null || group.query.isPending || group.query.isError || group.hasMore || group.pinned.length + group.rest.length + group.snoozed.length > 0);
  const order = visibleSidebarThreadIds(
    visible,
    collapsed.filter((id) => !id.startsWith("project:")),
  );
  const orderKey = JSON.stringify(order);
  useEffect(() => {
    useUi.getState().setThreadOrder(JSON.parse(orderKey) as string[]);
  }, [orderKey]);

  const row = (thread: ThreadSummary) => <ThreadRow key={thread.id} thread={thread} active={activeId === thread.id} />;
  const openProjectThreads = (id: string | null) => {
    const groups = id === null ? sections : sections.filter((group) => group.id === id);
    const first = groups.flatMap((group) => [...group.pinned, ...group.rest])[0];
    if (first) useRouter.getState().navigate({ view: "thread", threadId: first.id });
    else newThread(id ?? undefined);
  };
  const chooseProject = (id: string | null) => {
    setProject(id);
    setSearch("");
    setPinnedOnly(false);
    if (companionNavigation.active || (browsing && id !== null && id !== activeThread.data?.projectId)) openProjectThreads(id);
  };
  return (
    <>
      <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-browsing={browsing} aria-hidden={!open} inert={!open}>
        <WorkspaceRail
          route={route}
          projectId={projectId}
          orclings={companionNavigation}
          onProject={chooseProject}
          onThreads={() => {
            if (companionNavigation.active) companionNavigation.openThreads(() => openProjectThreads(projectId));
            else if (!browsing) openProjectThreads(projectId);
          }}
        />
        {companionNavigation.active ? <SidebarOrclings route={route} /> : null}
        {browsing && !companionNavigation.active ? (
          <section className="conversation-browser" aria-label="Thread browser">
            <header className="browser-toolbar drag-region h-topbar">
              <span className="browser-close">
                <SidebarToggle open />
              </span>
              <span>Threads</span>
              <Tooltip label="New thread">
                <IconButton
                  onClick={() => {
                    newThread(projectId ?? undefined);
                    dismissCompactNavigation();
                  }}
                  aria-label="New thread"
                  className="no-drag"
                >
                  <PenSquare size={17} />
                </IconButton>
              </Tooltip>
            </header>
            <div className="browser-heading">
              <ProjectPicker projectId={projectId} onProject={chooseProject} />
              <p>{filter === "archived" ? "Your archived conversations" : "Ideas, plans, and work in progress"}</p>
            </div>
            <div className="browser-controls">
              <div className="browser-tabs" aria-label="Threads to show">
                <button aria-pressed={!pinnedOnly} onClick={() => setPinnedOnly(false)}>
                  {filter === "archived" ? "Archived" : "All threads"}
                </button>
                <button aria-pressed={pinnedOnly} onClick={() => setPinnedOnly(true)} disabled={filter === "archived"}>
                  Pinned
                </button>
                <ThreadFilter
                  filter={filter}
                  onFilter={(value) => {
                    setFilter(value);
                    setPinnedOnly(false);
                  }}
                  projectId={project?.id}
                />
              </div>
              <label className="browser-search">
                <Search size={14} />
                <input aria-label="Filter loaded threads" placeholder="Find a thread…" value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
            </div>
            <div className="browser-threads">
              {visible.length === 0 ? <p className="browser-empty">{emptyBrowserMessage(search, pinnedOnly)}</p> : null}
              {visible.map((group) => (
                <section key={group.id} aria-label={`${group.name} threads`}>
                  {projectId === null ? <h3 className="browser-group-title">{group.name}</h3> : null}
                  {group.pinned.length > 0 ? (
                    <Section id={`pinned:${group.id}`} label="Pinned" count={group.pinned.length}>
                      {group.pinned.map(row)}
                    </Section>
                  ) : null}
                  {group.rest.map(row)}
                  {group.query.isPending ? <p className="browser-empty">Loading threads…</p> : null}
                  {group.query.isError ? (
                    <button className="browser-empty" onClick={() => void group.query.refetch()}>
                      Couldn’t load threads. Retry
                    </button>
                  ) : null}
                  {group.query.isSuccess && !group.pinned.length && !group.rest.length && !group.snoozed.length ? <p className="browser-empty">{emptyBrowserMessage(search, pinnedOnly)}</p> : null}
                  {group.hasMore ? (
                    <button className="browser-load-more" onClick={() => setLimits((value) => ({ ...value, [`${filter}:${group.id}`]: (value[`${filter}:${group.id}`] ?? PAGE) + PAGE }))}>
                      Load more threads
                    </button>
                  ) : null}
                  {group.snoozed.length > 0 ? (
                    <Section id={`snoozed-open:${group.id}`} label="Snoozed" count={group.snoozed.length} defaultCollapsed>
                      {group.snoozed.map(row)}
                    </Section>
                  ) : null}
                </section>
              ))}
            </div>
            <ThreadBrowserHint />
          </section>
        ) : null}
      </aside>
      {browsing && open ? <ResizeHandle edge="sidebar" /> : null}
    </>
  );
}

function ThreadBrowserHint() {
  return (
    <p className="browser-hint">
      <kbd>{window.openorc?.platform === "darwin" ? "⌘" : "Ctrl"}</kbd> click a thread to open it beside this one
    </p>
  );
}

function ThreadFilter({ filter, onFilter, projectId }: { filter: SidebarFilter; onFilter: (filter: SidebarFilter) => void; projectId?: string }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label="Filter threads" size="sm" />}>
        <ListFilter size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup className={menuPopup}>
            {(["active", "archived"] as const).map((value) => (
              <Menu.Item key={value} className={menuItem} onClick={() => onFilter(value)}>
                <Check size={13} className={filter === value ? "text-accent-ink" : "text-transparent"} />
                {value === "active" ? "Active threads" : "Archived threads"}
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item className={menuItem} onClick={() => useUi.getState().setImportSessions(true, projectId)}>
              Import terminal sessions…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Window navigation stays in the main toolbar, leaving the rail dedicated to app destinations. */
export function WindowNav({ open }: { open: boolean }) {
  const back = useRouter((s) => s.back);
  const forward = useRouter((s) => s.forward);
  const canBack = useRouter((s) => s.history.length > 0);
  const canForward = useRouter((s) => s.future.length > 0);
  return (
    <>
      <SidebarToggle open={open} />
      <InboxButton />
      {!open ? (
        <IconButton onClick={() => useUi.getState().setPalette(true)} aria-label="Search" className="no-drag">
          <Search size={15} />
        </IconButton>
      ) : null}
      <IconButton onClick={back} disabled={!canBack} aria-label="Back" className="no-drag window-history-control">
        <ArrowLeft size={15} />
      </IconButton>
      <IconButton onClick={forward} disabled={!canForward} aria-label="Forward" className="no-drag window-history-control">
        <ArrowRight size={15} />
      </IconButton>
    </>
  );
}

/** What waits for the user: approvals in the runs loaded here, and tasks to review or accept. */
function useInboxCount(): number {
  const approvals = usePendingApprovals();
  const tasks = useRpc("tasks.list", {});
  return approvals + (tasks.data ?? []).filter((task) => task.status === "review" || task.status === "proposed").length;
}

/** Opens the inbox, with what waits in it counted on the icon's corner. */
function InboxButton() {
  const current = useRouter((s) => s.route.view === "inbox");
  const count = useInboxCount();
  return (
    <Tooltip label="Inbox">
      <IconButton
        onClick={() => useRouter.getState().navigate({ view: "inbox" })}
        aria-label={count ? `Inbox, ${count}` : "Inbox"}
        aria-current={current ? "page" : undefined}
        className={cn("inbox-control nav-row no-drag", current && "text-ink")}
      >
        <span className="relative">
          <Inbox size={15} />
          {count ? <span className="nav-badge tabular transition-shadow">{count > 99 ? "99+" : count}</span> : null}
        </span>
      </IconButton>
    </Tooltip>
  );
}

/** Shows or hides the sidebar. Lives in the sidebar's header when open and in the main column's when hidden. */
export function SidebarToggle({ open }: { open: boolean }) {
  const toggle = useLayout((s) => s.toggleSidebar);
  return (
    <Tooltip label={open ? "Hide sidebar" : "Show sidebar"}>
      <IconButton onClick={toggle} aria-label="Toggle sidebar" className="no-drag">
        <PanelLeft size={15} />
      </IconButton>
    </Tooltip>
  );
}
