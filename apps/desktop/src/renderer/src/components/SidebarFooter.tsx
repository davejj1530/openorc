import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter } from "../lib/router";
import { useRpc } from "../lib/client";
import { useAccountSeatState } from "../lib/account-seat-state";
import { AccountUsage } from "./AccountUsage";
import { Settings } from "./icons";
import { SidebarAccount } from "./SidebarAccount";
import { SidebarUpdate } from "./SidebarUpdate";
import { Tooltip } from "./ui";

/**
 * The sidebar's foot, under a hairline: the signed-in person at its start, then the week's usage, the update once one
 * waits, and Settings, at the row's end.
 */
export function SidebarFooter() {
  const settings = useRouter((s) => s.route.view === "settings");
  const { account } = useAccountSeatState(useRpc("account.status", {}).data);
  const grace = account?.state === "signed-in" && account.organizationAccess?.state === "grace";
  return (
    <footer className="sidebar-footer">
      <SidebarAccount />
      {!grace ? <AccountUsage /> : null}
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
