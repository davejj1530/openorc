import { useContext } from "react";
import { focusedProject, useLayout } from "../lib/layout";
import { newThread, useRouter } from "../lib/router";
import { useTrafficLights } from "../lib/window";
import { useNavigationGone } from "../lib/navigation-column";
import { useProjectIconChanges } from "../lib/project-icons";
import { OrclingsRailContext, useOrclingsRail } from "../lib/orclings-rail";
import { useOrclings } from "../lib/orclings";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { PenSquare } from "./icons";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarListHead, Wordmark } from "./SidebarListHead";
import { NewOrclingButton, SidebarOrclings } from "./SidebarOrclings";
import { SidebarSettings } from "./SidebarSettings";
import { SidebarThreadBrowser, ThreadFilter } from "./SidebarThreadBrowser";
import { SidebarRail } from "./SidebarRail";
import { OrclingsHeading, ProjectFilter } from "./SidebarWorkspaces";
import { IconButton, Tooltip } from "./ui";
import { WindowCorner } from "./WindowCorner";

/**
 * One navigation column shared by every destination and every project: the window corner spans it, and under it the
 * rail of the app's screens, the week's usage at its foot, sits beside the thread list, which names whose threads it lists.
 * Settings lists its sections in the list's place. Hiding the sidebar folds the list and the corner away and keeps the
 * rail.
 */
export function Sidebar() {
  useProjectIconChanges();
  const route = useRouter((s) => s.route);
  const open = useLayout((s) => s.sidebarOpen);
  const gone = useNavigationGone();
  // A new thread starts in the project the list shows; on All projects, in the one last chosen for a new thread.
  const projectId = useLayout(focusedProject);
  const trafficLights = useTrafficLights();
  const nativeOrclings = useOrclingsRail(route, useOrclings());
  const orclings = useContext(OrclingsRailContext) ?? nativeOrclings;
  const openThreads = (project = projectId) => nativeOrclings.openThreads(() => newThread(project ?? undefined));
  const toggleOrclings = () => (orclings.active ? openThreads() : orclings.open());
  const settings = route.view === "settings";
  const chooseWorkspace = (id: string) => {
    useLayout.getState().setWorkspace(id);
    // Choosing a project shows its threads, in place of the Orclings: a new thread there, not in the one it left.
    if (orclings.active) openThreads(focusedProject({ workspace: id }));
  };
  return (
    <>
      <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-settings={settings || undefined} data-traffic-lights={trafficLights} aria-hidden={gone} inert={gone}>
        <SidebarHeader />
        <div className="sidebar-columns">
          <SidebarRail route={route} orclings={{ active: orclings.active, toggle: toggleOrclings }} onProject={chooseWorkspace} projectId={projectId} />
          <div className="sidebar-workspace">
            {settings ? <SidebarSettings route={route} /> : null}
            {/* Settings takes the list's place; the list keeps its pages, filters and scroll for the way back. */}
            <div className="sidebar-list-pane" hidden={settings}>
              {orclings.active ? <OrclingsHeading /> : <ProjectFilter onSelect={chooseWorkspace} />}
              <SidebarListHead
                tools={
                  orclings.active ? (
                    <NewOrclingButton />
                  ) : (
                    <>
                      <ThreadFilter />
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
          </div>
        </div>
      </aside>
      {open ? <ResizeHandle edge="sidebar" /> : null}
    </>
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
