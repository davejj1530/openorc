import { useContext } from "react";
import { focusedProject, useLayout } from "../lib/layout";
import { newThread, useRouter } from "../lib/router";
import { useTrafficLights } from "../lib/window";
import { useNavigationGone } from "../lib/navigation-column";
import { useProjectIconChanges } from "../lib/project-icons";
import { OrclingsModeContext, useOrclingsMode } from "../lib/orclings-mode";
import { useOrclings } from "../lib/orclings";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { Plus } from "./icons";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarFooter } from "./SidebarFooter";
import { Wordmark } from "./SidebarListHead";
import { SidebarNav } from "./SidebarNav";
import { NewOrclingButton, SidebarOrclings } from "./SidebarOrclings";
import { SidebarSettings } from "./SidebarSettings";
import { SidebarThreadBrowser } from "./SidebarThreadBrowser";
import { Tooltip } from "./ui";
import { SidebarToggle } from "./WindowCorner";

/**
 * The sidebar, one column with a hairline at its edge from the window's top to its foot: its header, the app's screens
 * by name, then the threads grouped by project under Workspaces, or the Orclings in their place, and the footer.
 * Settings lists its sections where the screens and threads go. Hidden, nothing of it stays.
 */
export function Sidebar() {
  useProjectIconChanges();
  const route = useRouter((s) => s.route);
  const open = useLayout((s) => s.sidebarOpen);
  const gone = useNavigationGone();
  const trafficLights = useTrafficLights();
  const nativeOrclings = useOrclingsMode(route, useOrclings());
  const orclings = useContext(OrclingsModeContext) ?? nativeOrclings;
  const projectId = useLayout(focusedProject);
  const toggleOrclings = () => (orclings.active ? nativeOrclings.openThreads(() => newThread(projectId ?? undefined)) : orclings.open());
  const settings = route.view === "settings";
  return (
    <>
      <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-traffic-lights={trafficLights} aria-hidden={gone} inert={gone}>
        <SidebarHeader projectId={projectId} />
        {settings ? <SidebarSettings route={route} /> : null}
        {/* Settings takes the screens' and threads' place; the list keeps its pages, filters and scroll for the way back. */}
        <div className="sidebar-body" hidden={settings}>
          <SidebarNav route={route} orclings={{ active: orclings.active, toggle: toggleOrclings, tools: <NewOrclingButton /> }} />
          {/* Keep loaded pages and filters while the Orclings take the threads' place. */}
          <div className="sidebar-browser-slot" hidden={orclings.active}>
            <SidebarThreadBrowser />
          </div>
          {orclings.active ? (
            <div className="sidebar-workspaces" data-open>
              <SidebarOrclings route={route} />
            </div>
          ) : null}
        </div>
        <SidebarFooter />
      </aside>
      {open ? <ResizeHandle edge="sidebar" /> : null}
    </>
  );
}

/**
 * The sidebar's header, where the window is dragged from: the traffic lights where the OS draws them, then whose
 * workspace this is, then New thread. Until there are organizations, the workspace is OpenOrc's own mark and name. A
 * narrow window floats the sidebar over the toggle that shows it, so the header carries its own way to hide it there.
 */
function SidebarHeader({ projectId }: { projectId: string | null }) {
  return (
    <header className="sidebar-header drag-region h-topbar">
      <SidebarToggle open className="sidebar-header-toggle" />
      <div className="sidebar-identity">
        <Wordmark />
      </div>
      <Tooltip label="New thread">
        <button
          type="button"
          aria-label="New thread"
          className="sidebar-new-thread no-drag"
          onClick={() => {
            newThread(projectId ?? undefined);
            dismissCompactNavigation();
          }}
        >
          <Plus size={16} />
        </button>
      </Tooltip>
    </header>
  );
}
