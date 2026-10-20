import { AccountUsage } from "./AccountUsage";
import { Plus, Settings } from "./icons";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { IconButton, Tooltip } from "./ui";

/**
 * Add project as a quiet row, then the open thread's weekly usage beside Settings, a round button. Settings already
 * fills the sidebar, so while it is open the footer steps away.
 */
export function SidebarFooter({ settings }: { settings: boolean }) {
  if (settings) return null;
  return (
    <footer className="sidebar-footer">
      <button type="button" className="sidebar-add-project no-drag" onClick={() => useUi.getState().setImportProject(true)}>
        <Plus size={16} />
        <span>Add project</span>
      </button>
      <div className="sidebar-account-row">
        <AccountUsage />
        <Tooltip label="Settings">
          <IconButton
            size="lg"
            aria-label="Settings"
            className="no-drag"
            onClick={() => {
              useRouter.getState().navigate({ view: "settings" });
              dismissCompactNavigation();
            }}
          >
            <Settings size={16} />
          </IconButton>
        </Tooltip>
      </div>
    </footer>
  );
}
