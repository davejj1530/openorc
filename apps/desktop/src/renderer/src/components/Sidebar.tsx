import { useContext } from "react";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { focusedProject, useLayout } from "../lib/layout";
import { newThread, useRouter } from "../lib/router";
import { useTrafficLights } from "../lib/window";
import { useNavigationGone } from "../lib/navigation-column";
import { useProjectIconChanges } from "../lib/project-icons";
import { OrclingsModeContext, useOrclingsMode } from "../lib/orclings-mode";
import { useOrclings } from "../lib/orclings";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarFooter } from "./SidebarFooter";
import { ListSwitcher, type ListChoice } from "./ListSwitcher";
import { SidebarListHead } from "./SidebarListHead";
import { SidebarNav } from "./SidebarNav";
import { NewOrclingButton, SidebarOrclings } from "./SidebarOrclings";
import { SidebarSettings } from "./SidebarSettings";
import { SidebarThreadBrowser } from "./SidebarThreadBrowser";
import { HistoryButtons, SidebarToggle } from "./WindowCorner";
import { OrganizationChat } from "./OrganizationChat";
import { OrganizationSidebarWork } from "./OrganizationSidebarWork";

/**
 * The sidebar, one column with a hairline at its edge from the window's top to its foot: its header, the app's screens
 * by name, then one list under a name that switches what it holds: a space's threads grouped by project, or the
 * Orclings. Then the footer. Settings lists its sections where the screens and the list go. Hidden, nothing of it stays.
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
  const settings = route.view === "settings";
  const startThread = () => newThread(focusedProject(useLayout.getState()) ?? undefined);
  const list: ListChoice = {
    orclings: orclings.active,
    showOrclings: () => {
      orclings.open();
      dismissCompactNavigation();
    },
    // In the space already in view, the thread last open there comes back. A space just picked brings its own place,
    // and gets a new thread only when that place is one of the Orclings' chats.
    showThreads: (stayed) => {
      if (stayed) nativeOrclings.openThreads(startThread);
      else if (nativeOrclings.showing()) startThread();
    },
  };
  const switcher = <ListSwitcher list={list} />;
  return (
    <>
      <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-traffic-lights={trafficLights} aria-hidden={gone} inert={gone}>
        <SidebarHeader />
        {settings ? <SidebarSettings route={route} /> : null}
        {/* Settings takes the screens' and threads' place; the list keeps its pages, filters and scroll for the way back. */}
        <div className="sidebar-body" hidden={settings}>
          <SidebarNav route={route} projectId={projectId} />
          {/* Keep loaded pages and filters while the Orclings take the threads' place. */}
          <div className="sidebar-browser-slot" hidden={orclings.active}>
            <OrganizationSidebarWork closed={<SidebarListHead name={switcher} tools={null} />}>
              <SidebarThreadBrowser name={switcher} />
            </OrganizationSidebarWork>
          </div>
          {orclings.active ? (
            <div className="sidebar-workspaces">
              <SidebarListHead name={switcher} tools={<NewOrclingButton />} />
              <SidebarOrclings route={route} />
            </div>
          ) : null}
          <OrganizationChat />
        </div>
        <SidebarFooter />
      </aside>
      {open ? <ResizeHandle edge="sidebar" /> : null}
    </>
  );
}

/**
 * The sidebar's header, where the window is dragged from: the traffic lights where the OS draws them, the toggle that
 * hides the sidebar beside them, on the spot the window's corner keeps it once hidden, then Back and Forward at the
 * header's end.
 */
function SidebarHeader() {
  return (
    <header className="sidebar-header drag-region h-topbar">
      <SidebarToggle open />
      <HistoryButtons size="xs" className="sidebar-history" />
    </header>
  );
}
