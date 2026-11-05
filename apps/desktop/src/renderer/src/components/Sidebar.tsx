import { useContext, useState } from "react";
import { useLayout } from "../lib/layout";
import { newThread, useRouter } from "../lib/router";
import { useTrafficLights, useWindow } from "../lib/window";
import { useProjectIconChanges } from "../lib/project-icons";
import { OrclingsRailContext, useOrclingsRail } from "../lib/orclings-rail";
import { useOrclings } from "../lib/orclings";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useUi } from "../lib/ui";
import { FolderPlus, PenSquare } from "./icons";
import { ResizeHandle } from "./ResizeHandle";
import { OpenOrcMark } from "./OpenOrcMark";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarListHead } from "./SidebarListHead";
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
  // Each list keeps its own search, so switching lists never loses what was typed.
  const [threadSearch, setThreadSearch] = useState("");
  const [orclingSearch, setOrclingSearch] = useState("");
  const toggleOrclings = () => (orclings.active ? nativeOrclings.openThreads(() => newThread(projectId ?? undefined)) : orclings.open());
  return (
    <>
      <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-traffic-lights={trafficLights} aria-hidden={!open} inert={!open}>
        <SidebarHeader />
        {route.view === "settings" ? <SidebarSettings route={route} /> : null}
        {/* Settings takes the column over; the app's navigation keeps its pages, filters and scroll for the way back. */}
        <div className="sidebar-workspace" hidden={route.view === "settings"}>
          {orclings.active ? (
            <SidebarListHead title="Orclings" search={orclingSearch} onSearch={setOrclingSearch} searchLabel="Find an Orcling" placeholder="Search Orclings" tools={<NewOrclingButton />} />
          ) : (
            <SidebarListHead
              title="Threads"
              search={threadSearch}
              onSearch={setThreadSearch}
              searchLabel="Filter loaded threads"
              placeholder="Search threads"
              tools={
                <>
                  <ThreadFilter />
                  <AddProjectButton />
                  <NewThreadButton projectId={projectId} />
                </>
              }
            />
          )}
          {/* Keep loaded pages and filters when switching to a companion. */}
          <div className="sidebar-browser-slot" hidden={orclings.active}>
            <SidebarThreadBrowser search={threadSearch} />
          </div>
          {orclings.active ? <SidebarOrclings route={route} search={orclingSearch} /> : null}
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

function SidebarHeader() {
  const fullscreen = useWindow((state) => state.fullscreen);
  return (
    <header className="sidebar-header drag-region h-topbar">
      {fullscreen ? (
        <div className="sidebar-brand" role="img" aria-label="OpenOrc">
          <OpenOrcMark size={20} className="shrink-0" />
          <span className="sidebar-wordmark">OpenOrc</span>
        </div>
      ) : (
        <span className="flex-1" />
      )}
      <WindowCorner sidebarOpen />
    </header>
  );
}

/** When navigation is hidden, the window corner moves to the main toolbar. */
export function WindowNav({ open }: { open: boolean }) {
  return <WindowCorner sidebarOpen={open} />;
}
