import { planLine } from "@openorc/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRpc } from "../lib/client";
import { useRouter } from "../lib/router";
import { AccountFace } from "./AccountFace";

/** The signed-in person at the foot's start: their face, name and plan, opening Settings > Account. Nothing while signed out. */
export function SidebarAccount() {
  const account = useRpc("account.status", {}).data;
  const open = useRouter((s) => s.route.view === "settings" && s.route.section === "account");
  if (account?.state !== "signed-in") return null;
  const name = account.name ?? account.email;
  return (
    <button
      type="button"
      className="sidebar-account no-drag"
      aria-current={open ? "page" : undefined}
      onClick={() => {
        useRouter.getState().navigate({ view: "settings", section: "account" });
        dismissCompactNavigation();
      }}
    >
      <AccountFace name={name} image={account.image} className="sidebar-account-face" />
      <span className="sidebar-account-words">
        <span className="sidebar-account-name">{name}</span>
        <span className="sidebar-account-plan">{planLine(account)}</span>
      </span>
    </button>
  );
}
