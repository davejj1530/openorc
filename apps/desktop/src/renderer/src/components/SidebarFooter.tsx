import { dismissCompactNavigation } from "../lib/compact-navigation";
import { closeSettings, useRouter } from "../lib/router";
import { Home, Settings } from "./icons";
import { SidebarAccount } from "./SidebarAccount";
import { SidebarUpdate } from "./SidebarUpdate";
import { Tooltip } from "./ui";

const openSettings = () => useRouter.getState().navigate({ view: "settings" });

/**
 * The sidebar's foot: the signed-in person at its start, then the update once one waits, and Settings, at the row's
 * end. While Settings is open its gear is a house, the way back out. The foot's glyphs are 18px, the size of the screens'.
 */
export function SidebarFooter() {
  const settings = useRouter((s) => s.route.view === "settings");
  const tool = settings ? { label: "Close Settings", Icon: Home, run: closeSettings } : { label: "Settings", Icon: Settings, run: openSettings };
  return (
    <footer className="sidebar-footer">
      <SidebarAccount />
      <SidebarUpdate />
      <Tooltip label={tool.label} side="top">
        <button
          type="button"
          aria-label={tool.label}
          className="sidebar-tool no-drag"
          onClick={() => {
            tool.run();
            dismissCompactNavigation();
          }}
        >
          <tool.Icon size={18} />
        </button>
      </Tooltip>
    </footer>
  );
}
