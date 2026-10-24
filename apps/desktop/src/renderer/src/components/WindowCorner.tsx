import { Inbox, PanelLeft, Search } from "./icons";
import { cn } from "../lib/cn";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useLayout } from "../lib/layout";
import { useRpc, usePendingApprovals } from "../lib/client";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { CountBadge, IconButton, Tooltip } from "./ui";

/**
 * The window's corner: Inbox, global search and the sidebar toggle. It sits in the sidebar's
 * header while the sidebar is open and in the main column's header while it is hidden. Window
 * history has no buttons; ⌘[ and ⌘] still go back and forward.
 */
export function WindowCorner({ sidebarOpen }: { sidebarOpen: boolean }) {
  return (
    <div className="window-corner" role="group" aria-label="Window">
      <InboxButton />
      <Tooltip label="Search">
        <IconButton size="lg" onClick={() => useUi.getState().setPalette(true)} aria-label="Search" className="no-drag">
          <Search size={16} />
        </IconButton>
      </Tooltip>
      <SidebarToggle open={sidebarOpen} />
    </div>
  );
}

/** What waits for the user: approvals in the runs loaded here, and tasks to review or accept. */
function useInboxCount(): number {
  const approvals = usePendingApprovals();
  const tasks = useRpc("tasks.list", {});
  return approvals + (tasks.data ?? []).filter((task) => task.status === "review" || task.status === "proposed").length;
}

/** Opens the Inbox page, with what waits in it counted on the icon's corner. */
function InboxButton() {
  const current = useRouter((s) => s.route.view === "inbox");
  const count = useInboxCount();
  return (
    <Tooltip label="Inbox">
      <IconButton
        size="lg"
        onClick={() => {
          useRouter.getState().navigate({ view: "inbox" });
          dismissCompactNavigation();
        }}
        aria-label={count ? `Inbox, ${count}` : "Inbox"}
        aria-current={current ? "page" : undefined}
        className={cn("window-corner-inbox relative no-drag", current && "bg-surface-2 text-ink")}
      >
        <Inbox size={16} />
        {count ? <CountBadge count={count} size="sm" className="window-corner-badge" /> : null}
      </IconButton>
    </Tooltip>
  );
}

/** Shows or hides the sidebar. */
function SidebarToggle({ open }: { open: boolean }) {
  const toggle = useLayout((s) => s.toggleSidebar);
  return (
    <Tooltip label={open ? "Hide sidebar" : "Show sidebar"}>
      <IconButton size="lg" onClick={toggle} aria-label="Toggle sidebar" className="no-drag">
        <PanelLeft size={16} />
      </IconButton>
    </Tooltip>
  );
}
