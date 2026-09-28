import { harnessShortName, isHarnessId, WORKSPACE_ID } from "@openorc/protocol";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  GitPullRequest,
  Inbox,
  ListFilter,
  ListTodo,
  PanelLeft,
  PenSquare,
  Plus,
  Search,
  Settings,
  Workflow,
} from "./icons";
import { useEffect, useState, type ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { useQueries } from "@tanstack/react-query";
import { core } from "../lib/rpc";
import { tagsFor } from "../lib/query";
import { ResizeHandle } from "./ResizeHandle";
import { HarnessLogo } from "./HarnessLogo";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { menuItem, menuPopup, ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useLayout, type SidebarFilter } from "../lib/layout";
import { useRpc } from "../lib/query";
import { newThread, useRouter, type Route } from "../lib/router";
import { usePendingApprovals } from "../lib/transcript";
import { useUi } from "../lib/ui";
import { startThreadDrag, endThreadDrag } from "../lib/thread-drag";
import { useTrafficLights } from "../lib/window";
import { CoversPreview } from "../lib/browser-preview";
import { sidebarThreadPage, visibleSidebarThreadIds } from "../lib/sidebar-thread-groups";
import { SidebarProjectHeading } from "./SidebarProjectHeading";
import { useProjectIconChanges } from "../lib/project-icons";
import { pullRequestNumber } from "../lib/pull-requests";
import openOrcMark from "../assets/openorc-mark.png";

const PAGE = 8;

function NavItem({ route, icon, label, badge, active, onClick }: { route?: Route; icon: ReactNode; label: string; badge?: number; active: boolean; onClick?: () => void }) {
  const navigate = useRouter((s) => s.navigate);
  return (
    <button
      onClick={() => {
        if (onClick) onClick();
        else if (route) navigate(route);
      }}
      aria-current={active ? "page" : undefined}
      aria-label={badge ? `${label}, ${badge}` : undefined}
      className={cn("nav-row no-drag w-full flex items-center gap-3 h-9 px-2 rounded-md text-md font-normal text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink", active && "text-ink")}
    >
      <span className={cn("relative text-ink-3", active && "text-ink")}>
        {icon}
        {badge ? <span className="nav-badge tabular transition-shadow">{badge > 99 ? "99+" : badge}</span> : null}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
    </button>
  );
}

/** The app's screens, above the projects. */
function SidebarNav({ route, projectId, inbox }: { route: Route; projectId: string | null; inbox: number }) {
  return (
    <nav className="nav-track grid grid-cols-1 min-w-0 gap-px">
      <NavItem route={{ view: "inbox" }} icon={<Inbox size={15} />} label="Inbox" badge={inbox} active={route.view === "inbox"} />
      <NavItem route={{ view: "tasks" }} icon={<ListTodo size={15} />} label="Tasks" active={route.view === "tasks" || route.view === "task" || route.view === "newtask"} />
      <NavItem route={{ view: "pulls" }} icon={<GitPullRequest size={15} />} label="Pull requests" active={route.view === "pulls" || route.view === "pull"} />
      <NavItem route={{ view: "scheduled" }} icon={<CalendarClock size={15} />} label="Scheduled" active={route.view === "scheduled"} />
      <NavItem route={{ view: "orchestration", ...(projectId ? { projectId } : {}) }} icon={<Workflow size={15} />} label="Orchestration" active={route.view === "orchestration"} />
      <NavItem route={{ view: "memory" }} icon={<Brain size={15} />} label="Memory" active={route.view === "memory"} />
    </nav>
  );
}

/** Where a thread works, as its row shows it: its branch, the pull request it reviews, or its folder. */
function threadPlace(thread: ThreadSummary): { icon: ReactNode; label: string; title: string } {
  if (thread.branch) return { icon: <GitBranch size={11} className="shrink-0" />, label: thread.branch, title: thread.branch };
  const pull = pullRequestNumber(thread.prUrl);
  if (thread.prUrl && pull !== null) return { icon: <GitPullRequest size={11} className="shrink-0" />, label: `PR #${pull}`, title: thread.prUrl };
  return { icon: <Folder size={11} className="shrink-0" />, label: thread.projectId === WORKSPACE_ID ? "Local" : "No branch", title: thread.workingDirectory ?? "No recorded branch" };
}

/**
 * A thread row: title, then what matters at a glance. ⌘-click opens it in
 * the split; right-click gives every action.
 */
function ThreadRow({ thread, active }: { thread: ThreadSummary; active: boolean }) {
  const navigate = useRouter((s) => s.navigate);
  const addPane = useRouter((s) => s.addThreadPane);
  const split = useRouter((s) => s.threadIds.includes(thread.id));
  const agents = thread.agents?.length ? thread.agents : [thread.agent];
  const providers = [...new Set(agents)].map((agent) => ({ agent, count: agents.filter((item) => item === agent).length }));
  const team = agents.length > 1;
  const agentLabel = providers.map(({ agent, count }) => `${team ? `${count} × ` : ""}${harnessShortName(agent)}`).join(", ");
  const place = threadPlace(thread);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <button
            draggable
            onDragStart={(event) => startThreadDrag(event.dataTransfer, thread.id)}
            onDragEnd={endThreadDrag}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) addPane(thread.id);
              else {
                useLayout.getState().setProject(thread.projectId);
                navigate({ view: "thread", threadId: thread.id });
              }
            }}
            aria-current={active ? "page" : undefined}
            className={cn(
              "sidebar-thread-row no-drag min-w-0 w-full flex flex-col items-stretch gap-0.5 px-2 py-1.5 rounded-md text-base text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink",
              active && "text-ink",
              split && !active && "ring-1 ring-inset ring-line-strong",
            )}
            title={thread.title}
          />
        }
      >
        <span className="flex min-w-0 items-center">
          <span className={cn("flex-1 min-w-0 text-left truncate font-normal", (active || thread.unread || thread.activity === "waiting") && "text-ink")}>{thread.title}</span>
          <ThreadStatusIndicator thread={thread} />
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs leading-4 text-ink-3">
          <span className="flex flex-1 min-w-0 items-center gap-1" title={place.title}>
            {place.icon}
            <span className="truncate">{place.label}</span>
          </span>
          <span
            className="inline-flex shrink-0 items-center gap-1.5"
            role="img"
            aria-label={team ? `Team agents: ${agentLabel}` : `Agent: ${agentLabel}`}
            title={team ? `Team agents: ${agentLabel}` : agentLabel}
          >
            {providers.map(({ agent, count }) => (
              <span key={agent} className="inline-flex items-center gap-1">
                {isHarnessId(agent) ? <HarnessLogo id={agent} size={12} className="shrink-0" /> : null}
                <span className="tabular">{team ? count : harnessShortName(agent)}</span>
              </span>
            ))}
          </span>
        </span>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <CoversPreview />
        <ContextMenu.Positioner className="z-40" collisionPadding={8}>
          <ContextMenu.Popup className={menuPopup}>
            <ThreadMenuItems thread={thread} parts={ContextMenu as unknown as MenuParts} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
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

const filterLabel: Record<SidebarFilter, string> = {
  active: "Active",
  archived: "Archived",
};

/**
 * Navigation and project-grouped threads under one header that
 * carries the window's traffic lights, search, and history. Hidden entirely
 * when collapsed; the main column's header then carries the toggle.
 */
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
  const trafficLights = useTrafficLights();
  const projects = useRpc("projects.list", {});
  const tasks = useRpc("tasks.list", {});
  const groups = [{ id: WORKSPACE_ID, name: "Workspace" }, ...(projects.data ?? [])];
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
  const pendingApprovals = usePendingApprovals();
  const inbox = pendingApprovals + (tasks.data ?? []).filter((t) => t.status === "review" || t.status === "proposed").length;
  const project = (projects.data ?? []).find((p) => p.id === projectId) ?? null;
  const activeId = route.view === "thread" ? route.threadId : null;
  const activeThread = useRpc("threads.get", { id: activeId ?? "" }, { enabled: !!activeId });
  const activeProjectId = activeThread.data?.projectId;
  useEffect(() => {
    if (!activeId || !activeProjectId) return;
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
    const page = sidebarThreadPage({ projectId: group.id, fetched: query.data, selected: activeThread.data, filter, limit, now });
    return { ...group, query, ...page };
  });
  const order = visibleSidebarThreadIds(sections, collapsed);
  const orderKey = JSON.stringify(order);
  useEffect(() => {
    useUi.getState().setThreadOrder(JSON.parse(orderKey) as string[]);
  }, [orderKey]);

  const row = (t: ThreadSummary) => <ThreadRow key={t.id} thread={t} active={activeId === t.id} />;

  return (
    <div className="flex shrink-0 h-full">
      <div className="sidebar-shell h-full" data-open={open} aria-hidden={!open} inert={!open}>
        <div className="h-full flex flex-col" style={{ width: "calc(var(--width-sidebar) + var(--spacing-well))" }}>
          <header className={cn("drag-region h-topbar shrink-0 flex items-center gap-1 pr-2", trafficLights ? "pl-traffic" : "pl-2")}>
            <WindowNav open />
          </header>
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="sidebar-brand flex h-12 shrink-0 items-center gap-2 px-4">
                <img src={openOrcMark} alt="" width={22} height={22} className="sidebar-brand-mark shrink-0" />
                <span className="sidebar-wordmark min-w-0 flex-1 truncate">OpenOrc</span>
                <Tooltip label="New thread">
                  <IconButton onClick={() => newThread(projectId ?? undefined)} aria-label="New thread" className="no-drag sidebar-brand-new-thread">
                    <PenSquare size={17} />
                  </IconButton>
                </Tooltip>
              </div>
              <SidebarNav route={route} projectId={projectId} inbox={inbox} />
              <div className="flex items-center gap-0.5 pl-4 pr-2 mt-4 mb-1">
                <span className="text-sm font-medium text-ink-3">Projects</span>
                <span className="flex-1" />
                <Menu.Root>
                  <Tooltip label="Which threads to list">
                    <Menu.Trigger
                      aria-label="Filter threads"
                      className={cn("no-drag h-6 px-1.5 rounded-md inline-flex items-center gap-1 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink", filter !== "active" && "text-ink")}
                    >
                      <ListFilter size={13} />
                      {filter !== "active" ? filterLabel[filter] : null}
                    </Menu.Trigger>
                  </Tooltip>
                  <Menu.Portal>
                    <CoversPreview />
                    <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
                      <Menu.Popup className={menuPopup}>
                        {(Object.keys(filterLabel) as SidebarFilter[]).map((f) => (
                          <Menu.Item key={f} className={menuItem} onClick={() => setFilter(f)}>
                            <span className={cn("w-3.5", filter === f ? "text-accent-ink" : "text-transparent")}>
                              <Check size={13} />
                            </span>
                            {filterLabel[f]}
                          </Menu.Item>
                        ))}
                        <Menu.Separator className="my-1 h-px bg-line" />
                        <Menu.Item className={menuItem} onClick={() => useUi.getState().setImportSessions(true, project?.id)}>
                          Import terminal sessions…
                        </Menu.Item>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
                <Tooltip label="Add project">
                  <IconButton onClick={() => useUi.getState().setImportProject(true)} aria-label="Add project" size="sm" className="no-drag">
                    <Plus size={14} />
                  </IconButton>
                </Tooltip>
              </div>
              {/* Inset the content, not the scroll container, so the scrollbar stays in the gutter. */}
              <div className="sidebar-threads flex-1 min-h-0 overflow-y-auto pl-2 content-start">
                <div className="sidebar-thread-content">
                  {sections.map((group) => {
                    const expanded = !collapsed.includes(`project:${group.id}`);
                    return (
                      <section key={group.id} className="sidebar-project mb-3" aria-label={`${group.name} threads`}>
                        <SidebarProjectHeading group={group} expanded={expanded} />
                        {expanded ? (
                          <div id={`project-threads-${group.id}`}>
                            {group.pinned.length > 0 ? (
                              <Section id={`pinned:${group.id}`} label="Pinned" count={group.pinned.length}>
                                {group.pinned.map(row)}
                              </Section>
                            ) : null}
                            <div className="grid grid-cols-1 min-w-0 gap-px">{group.rest.map(row)}</div>
                            {group.query.isPending ? <div className="px-2 py-1 text-sm text-ink-3">Loading threads…</div> : null}
                            {group.query.isError ? (
                              <button onClick={() => void group.query.refetch()} className="px-2 py-1 text-sm text-ink-3 hover:text-ink">
                                Couldn’t load threads. Retry
                              </button>
                            ) : null}
                            {group.query.isSuccess && group.list.length === 0 ? (
                              <div className="px-2 py-1 text-sm text-ink-3">{filter === "active" ? "No threads yet" : "No archived threads"}</div>
                            ) : null}
                            {group.hasMore ? (
                              <button
                                onClick={() => setLimits((value) => ({ ...value, [`${filter}:${group.id}`]: (value[`${filter}:${group.id}`] ?? PAGE) + PAGE }))}
                                className="w-full h-7 px-2 text-left text-sm text-ink-3 hover:text-ink"
                              >
                                Show more…
                              </button>
                            ) : null}
                            {group.snoozed.length > 0 ? (
                              <Section id={`snoozed-open:${group.id}`} label="Snoozed" count={group.snoozed.length} defaultCollapsed>
                                {group.snoozed.map(row)}
                              </Section>
                            ) : null}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                  {projects.isError ? (
                    <button onClick={() => void projects.refetch()} className="px-2 py-1 text-sm text-ink-3 hover:text-ink">
                      Couldn’t load projects. Retry
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="px-2 pb-2 pt-1">
                <NavItem route={{ view: "settings" }} icon={<Settings size={15} />} label="Settings" active={route.view === "settings" || route.view === "diagnostics"} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {open ? <ResizeHandle edge="sidebar" /> : null}
    </div>
  );
}

/** The window's navigation: sidebar toggle, search and history. In the sidebar's header while it is open, in the main header while it is hidden. */
export function WindowNav({ open }: { open: boolean }) {
  const back = useRouter((s) => s.back);
  const forward = useRouter((s) => s.forward);
  const canBack = useRouter((s) => s.history.length > 0);
  const canForward = useRouter((s) => s.future.length > 0);
  return (
    <>
      <SidebarToggle open={open} />
      <IconButton onClick={() => useUi.getState().setPalette(true)} aria-label="Search" className="no-drag">
        <Search size={15} />
      </IconButton>
      <IconButton onClick={back} disabled={!canBack} aria-label="Back" className="no-drag">
        <ArrowLeft size={15} />
      </IconButton>
      <IconButton onClick={forward} disabled={!canForward} aria-label="Forward" className="no-drag">
        <ArrowRight size={15} />
      </IconButton>
    </>
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
