import { useContext } from "react";
import { useLayout } from "../lib/layout";
import { newThread, useRouter } from "../lib/router";
import { useTrafficLights } from "../lib/window";
import { useProjectIconChanges } from "../lib/project-icons";
import { OrclingsRailContext, useOrclingsRail } from "../lib/orclings-rail";
import { useOrclings } from "../lib/orclings";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useUi } from "../lib/ui";
import { FolderPlus, PenSquare } from "./icons";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarListHead, Wordmark } from "./SidebarListHead";
import { NewOrclingButton, SidebarOrclings } from "./SidebarOrclings";
import { SidebarSettings } from "./SidebarSettings";
import { SidebarThreadBrowser, ThreadFilter } from "./SidebarThreadBrowser";
import { IconButton, Tooltip } from "./ui";
import { WindowCorner } from "./WindowCorner";

/** One navigation column shared by every destination and every project. */
export function Sidebar() {
  useProjectIconChanges();
  const route = useRouter((s) => s.route);
  const open = useLayout((s) => s.sidebarOpen);
  const projectId = useLayout((s) => s.projectId);
  const trafficLights = useTrafficLights();
  const nativeOrclings = useOrclingsRail(route, useOrclings());
  const orclings = useContext(OrclingsRailContext) ?? nativeOrclings;
  const toggleOrclings = () => (orclings.active ? nativeOrclings.openThreads(() => newThread(projectId ?? undefined)) : orclings.open());
  return (
    <>
      <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-traffic-lights={trafficLights} aria-hidden={!open} inert={!open}>
        <SidebarHeader />
        {route.view === "settings" ? <SidebarSettings route={route} /> : null}
        {/* Settings takes the column over; the app's navigation keeps its pages, filters and scroll for the way back. */}
        <div className="sidebar-workspace" hidden={route.view === "settings"}>
          <SidebarListHead
            tools={
              orclings.active ? (
                <NewOrclingButton />
              ) : (
                <>
                  <ThreadFilter />
                  <AddProjectButton />
                  <NewThreadButton projectId={projectId} />
                </>
              )
            }
          />
          {/* Keep loaded pages and filters when switching to a companion. */}
          <div className="sidebar-browser-slot" hidden={orclings.active}>
            <SidebarThreadBrowser />
          </div>
          {orclings.active ? <SidebarOrclings route={route} /> : null}
        </div>
        <SidebarFooter route={route} projectId={projectId} orclings={{ active: orclings.active, toggle: toggleOrclings }} />
      </aside>
      {open ? <ResizeHandle edge="sidebar" /> : null}
    </>
  );
}

function AddProjectButton() {
  return (
    <Tooltip label="Add project">
      <IconButton size="lg" aria-label="Add project" className="no-drag" onClick={() => useUi.getState().setImportProject(true)}>
        <FolderPlus size={16} />
      </IconButton>
    </Tooltip>
  );
}

function NewThreadButton({ projectId }: { projectId: string | null }) {
  return (
    <Tooltip label="New thread">
      <IconButton
        size="lg"
        aria-label="New thread"
        className="sidebar-new-thread no-drag"
        onClick={() => {
          newThread(projectId ?? undefined);
          dismissCompactNavigation();
        }}
      >
        <PenSquare size={16} />
      </IconButton>
    </Tooltip>
  );
}

/** The window's corner: the wordmark, after the traffic lights where the OS draws them, then Inbox and the sidebar toggle. */
function SidebarHeader() {
  return (
    <header className="sidebar-header drag-region h-topbar">
      <Wordmark />
      <WindowCorner sidebarOpen />
    </header>
  );
}

/** When navigation is hidden, the window corner moves to the main toolbar. */
export function WindowNav({ open }: { open: boolean }) {
  return <WindowCorner sidebarOpen={open} />;
}
