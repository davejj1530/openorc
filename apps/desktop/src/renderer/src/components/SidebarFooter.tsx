import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter } from "../lib/router";
import { AccountUsage } from "./AccountUsage";
import { Settings } from "./icons";
import { SidebarUpdate } from "./SidebarUpdate";
import { Tooltip } from "./ui";

/**
 * The sidebar's foot, under a hairline: the week's usage, the update once one waits, and Settings, at the row's end. Its
 * start stays clear for the signed-in person.
 */
export function SidebarFooter() {
  const settings = useRouter((s) => s.route.view === "settings");
  return (
    <footer className="sidebar-footer">
      <AccountUsage />
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
