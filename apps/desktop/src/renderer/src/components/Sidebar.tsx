import { useContext } from "react";
import { ArrowLeft, ArrowRight, Plus, Inbox, PanelLeft, PenSquare, Search, Settings } from "./icons";
import { useLayout } from "../lib/layout";
import { newThread, useRouter } from "../lib/router";
import { usePendingApprovals } from "../lib/transcript";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useTrafficLights } from "../lib/window";
import { useUi } from "../lib/ui";
import { useRpc } from "../lib/query";
import { useProjectIconChanges } from "../lib/project-icons";
import { OrclingsRailContext, useOrclingsRail } from "../lib/orclings-rail";
import { useOrclings } from "../lib/orclings";
import { cn } from "../lib/cn";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarNav } from "./SidebarNav";
import { SidebarOrclings } from "./SidebarOrclings";
import { SidebarThreadBrowser } from "./SidebarThreadBrowser";
import { IconButton, Tooltip } from "./ui";

/** One navigation column shared by every destination and every project. */
export function Sidebar() {
  useProjectIconChanges();
  const route = useRouter((s) => s.route);
  const open = useLayout((s) => s.sidebarOpen);
  const projectId = useLayout((s) => s.projectId);
  const trafficLights = useTrafficLights();
  const nativeOrclings = useOrclingsRail(route, useOrclings());
  const orclings = useContext(OrclingsRailContext) ?? nativeOrclings;
  return (
    <>
      <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-traffic-lights={trafficLights} aria-hidden={!open} inert={!open}>
        <SidebarHeader />
        <div className="sidebar-destinations">
          <button
            className="sidebar-new-thread nav-row"
            onClick={() => {
              newThread(projectId ?? undefined);
              dismissCompactNavigation();
            }}
          >
            <PenSquare size={16} />
            <span>New thread</span>
          </button>
          <SidebarNav route={route} projectId={projectId} />
        </div>
        <div className="sidebar-browser-tabs" aria-label="Conversations">
          <button aria-current={!orclings.active ? "page" : undefined} onClick={() => nativeOrclings.openThreads(() => newThread(projectId ?? undefined))}>
            Threads
          </button>
          <button aria-current={orclings.active ? "page" : undefined} onClick={orclings.open}>
            Orclings
          </button>
        </div>
        {/* Keep loaded pages and filters when switching to a companion. */}
        <div className="sidebar-browser-slot" hidden={orclings.active}>
          <SidebarThreadBrowser />
        </div>
        {orclings.active ? <SidebarOrclings route={route} /> : null}
        <SidebarFooter />
      </aside>
      {open ? <ResizeHandle edge="sidebar" /> : null}
    </>
  );
}

function SidebarHeader() {
  return (
    <header className="sidebar-header drag-region h-topbar">
      <span className="sidebar-app-name">OpenOrc</span>
      <SidebarToggle open />
      <Tooltip label="Search">
        <IconButton onClick={() => useUi.getState().setPalette(true)} aria-label="Search" className="no-drag">
          <Search size={15} />
        </IconButton>
      </Tooltip>
    </header>
  );
}

function SidebarFooter() {
  const settings = useRouter((s) => s.route.view === "settings");
  return (
    <footer className="sidebar-footer">
      <button className="sidebar-add-project" onClick={() => useUi.getState().setImportProject(true)}>
        <Plus size={15} />
        Add project
      </button>
      <div className="sidebar-footer-controls">
        <button
          className="sidebar-settings nav-row"
          aria-current={settings ? "page" : undefined}
          onClick={() => {
            useRouter.getState().navigate({ view: "settings" });
            dismissCompactNavigation();
          }}
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>
        <InboxButton />
        <HistoryNav />
      </div>
    </footer>
  );
}

/** When navigation is hidden, its window controls remain available in the main toolbar. */
export function WindowNav({ open }: { open: boolean }) {
  return (
    <>
      <SidebarToggle open={open} />
      <InboxButton />
      {!open ? (
        <IconButton onClick={() => useUi.getState().setPalette(true)} aria-label="Search" className="no-drag">
          <Search size={15} />
        </IconButton>
      ) : null}
      <HistoryNav />
    </>
  );
}

function HistoryNav() {
  const back = useRouter((s) => s.back);
  const forward = useRouter((s) => s.forward);
  const canBack = useRouter((s) => s.history.length > 0);
  const canForward = useRouter((s) => s.future.length > 0);
  return (
    <>
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
