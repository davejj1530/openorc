import { useEffect, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { Menu } from "@base-ui/react/menu";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout, type SidebarFilter } from "../lib/layout";
import { useOrclings } from "../lib/orclings";
import { tagsFor, useRpc } from "../lib/query";
import { useRouter } from "../lib/router";
import { core } from "../lib/rpc";
import { sidebarThreadPage, visibleSidebarThreadIds } from "../lib/sidebar-thread-groups";
import { useUi } from "../lib/ui";
import { Check, ChevronDown, ChevronRight, ListFilter, Pin, Search } from "./icons";
import { SidebarProjectGroup } from "./SidebarProjectGroup";
import { ThreadRow } from "./ThreadLibraryRow";
import { menuItem, menuPopup } from "./ThreadActions";
import { IconButton } from "./ui";

const PAGE = 12;

function emptyMessage(search: string, pinned: boolean): string {
  if (search) return "No matches in loaded threads.";
  return pinned ? "No pinned threads." : "No threads yet.";
}

/** Each project owns a page. The task/new-thread scope never hides another project's work. */
function useThreadGroups(search: string, pinnedOnly: boolean) {
  const filter = useLayout((s) => s.sidebarFilter);
  const collapsed = useLayout((s) => s.collapsed);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const projects = useRpc("projects.list", {});
  const groups = [{ id: WORKSPACE_ID, name: "Workspace", rootPath: undefined }, ...(projects.data ?? [])];
  const orclings = useOrclings();
  const homes = new Set(orclings.map((orcling) => orcling.threadId));
  const activeId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const active = useRpc("threads.get", { id: activeId ?? "" }, { enabled: Boolean(activeId) });
  const activeProject = activeId && !homes.has(activeId) ? active.data?.projectId : undefined;
  const queries = useQueries({
    queries: groups.map((group) => {
      const params = { projectId: group.id, filter, limit: (limits[`${filter}:${group.id}`] ?? PAGE) + 1 };
      return { queryKey: ["threads.list", params], queryFn: () => core.call("threads.list", params), meta: { tags: tagsFor("threads.list", params) }, refetchInterval: 60_000 };
    }),
  });
  useEffect(() => {
    if (!activeProject) return;
    const layout = useLayout.getState();
    const key = `project:${activeProject}`;
    if (layout.collapsed.includes(key)) layout.toggleCollapsed(key);
  }, [activeId, activeProject]);
  useEffect(() => {
    if (!projects.data) return;
    const { projectId, setProject } = useLayout.getState();
    if (projectId && projectId !== WORKSPACE_ID && !projects.data.some((p) => p.id === projectId)) setProject(WORKSPACE_ID);
  }, [projects.data]);
  const matches = (thread: ThreadSummary) => thread.title.toLowerCase().includes(search.toLowerCase());
  const visible = groups.map((group, index) => {
    const query = queries[index]!;
    const page = sidebarThreadPage({ projectId: group.id, fetched: query.data, selected: active.data, filter, limit: limits[`${filter}:${group.id}`] ?? PAGE, now: Date.now(), hidden: homes });
    return { ...group, query, ...page, pinned: page.pinned.filter(matches), rest: pinnedOnly ? [] : page.rest.filter(matches), snoozed: pinnedOnly ? [] : page.snoozed.filter(matches) };
  });
  const orderKey = JSON.stringify(visibleSidebarThreadIds(visible, collapsed));
  useEffect(() => {
    useUi.getState().setThreadOrder(JSON.parse(orderKey) as string[]);
  }, [orderKey]);
  const loadMore = (id: string) => setLimits((old) => ({ ...old, [`${filter}:${id}`]: (old[`${filter}:${id}`] ?? PAGE) + PAGE }));
  return { visible, activeId, loadMore, projects };
}

/** The project list stays mounted across app destinations, keeping filters and loaded pages. */
export function SidebarThreadBrowser() {
  const [search, setSearch] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const { visible, activeId, loadMore, projects } = useThreadGroups(search, pinnedOnly);
  const row = (thread: ThreadSummary) => <ThreadRow key={thread.id} thread={thread} active={activeId === thread.id} />;
  return (
    <section className="conversation-browser" aria-label="Thread browser">
      <div className="browser-controls">
        <label className="browser-search">
          <Search size={13} />
          <input aria-label="Filter loaded threads" placeholder="Filter threads…" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <ThreadFilter pinned={pinnedOnly} onPinned={setPinnedOnly} />
      </div>
      <div className="browser-threads">
        {projects.isError ? (
          <button className="browser-empty" onClick={() => void projects.refetch()}>
            Couldn’t load projects. Retry
          </button>
        ) : null}
        {visible.map((group) => (
          <SidebarProjectGroup key={group.id} id={group.id} name={group.name} rootPath={group.rootPath} threads={group.list}>
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
            {group.query.isSuccess && !group.pinned.length && !group.rest.length && !group.snoozed.length ? <p className="browser-empty">{emptyMessage(search, pinnedOnly)}</p> : null}
            {group.hasMore ? (
              <button className="browser-load-more" onClick={() => loadMore(group.id)}>
                Load more threads
              </button>
            ) : null}
            {group.snoozed.length > 0 ? (
              <Section id={`snoozed-open:${group.id}`} label="Snoozed" count={group.snoozed.length} defaultCollapsed>
                {group.snoozed.map(row)}
              </Section>
            ) : null}
          </SidebarProjectGroup>
        ))}
      </div>
    </section>
  );
}

function Section({ id, label, count, children, defaultCollapsed = false }: { id: string; label: string; count: number; children: ReactNode; defaultCollapsed?: boolean }) {
  const collapsed = useLayout((s) => s.collapsed);
  const toggle = useLayout((s) => s.toggleCollapsed);
  const open = defaultCollapsed ? collapsed.includes(id) : !collapsed.includes(id);
  return (
    <div className="browser-thread-section">
      <button aria-expanded={open} onClick={() => toggle(id)} className="w-full flex items-center gap-1 h-6 pl-2 pr-2 text-xs text-ink-3 hover:text-ink">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>{label}</span>
        <span className="tabular">{count}</span>
      </button>
      {open ? <div className="grid grid-cols-1 min-w-0 gap-px">{children}</div> : null}
    </div>
  );
}

function ThreadFilter({ pinned, onPinned }: { pinned: boolean; onPinned: (value: boolean) => void }) {
  const filter = useLayout((s) => s.sidebarFilter);
  const setFilter = useLayout((s) => s.setSidebarFilter);
  const projectId = useLayout((s) => s.projectId);
  const selection = pinned ? "pinned" : filter;
  const choose = (value: SidebarFilter) => {
    setFilter(value);
    onPinned(false);
  };
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={`Filter threads${selection === "active" ? "" : `: ${selection}`}`} size="sm" className={selection !== "active" ? "text-accent-ink" : ""} />}>
        {pinned ? <Pin size={14} /> : <ListFilter size={14} />}
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup className={menuPopup}>
            {(["active", "archived"] as const).map((value) => (
              <Menu.Item key={value} className={menuItem} onClick={() => choose(value)}>
                <Check size={13} className={filter === value && !pinned ? "text-accent-ink" : "text-transparent"} />
                {value === "active" ? "Active threads" : "Archived threads"}
              </Menu.Item>
            ))}
            <Menu.Item
              className={menuItem}
              onClick={() => {
                setFilter("active");
                onPinned(!pinned);
              }}
            >
              <Check size={13} className={pinned ? "text-accent-ink" : "text-transparent"} />
              Pinned threads
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item className={menuItem} onClick={() => useUi.getState().setImportSessions(true, projectId ?? undefined)}>
              Import terminal sessions…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
