import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter } from "../lib/router";
import { Settings } from "./icons";
import { SidebarAccount } from "./SidebarAccount";
import { SidebarUpdate } from "./SidebarUpdate";
import { Tooltip } from "./ui";

/** The sidebar's foot: the signed-in person at its start, then the update once one waits, and Settings, at the row's end. */
export function SidebarFooter() {
  const settings = useRouter((s) => s.route.view === "settings");
  return (
    <footer className="sidebar-footer">
      <SidebarAccount />
      <SidebarUpdate />
      <Tooltip label="Settings" side="top">
        <button
          type="button"
          aria-label="Settings"
          aria-current={settings ? "page" : undefined}
          className="sidebar-tool no-drag"
          onClick={() => {
            useRouter.getState().navigate({ view: "settings" });
            dismissCompactNavigation();
          }}
        >
          <Settings size={16} />
        </button>
      </Tooltip>
    </footer>
  );
}
