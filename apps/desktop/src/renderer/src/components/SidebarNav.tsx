import type { ReactNode } from "react";
import { NEEDS_YOU_PAGE, threadStatus, waitsOnYou } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { usePendingApprovals, useRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import type { SidebarScreen } from "../lib/layout";
import { useOrclingChatIds } from "../lib/orclings";
import { useRouter, type Route } from "../lib/router";
import { waitingTaskCount } from "../lib/task-stage-counts";
import { Inbox, Orclings } from "./icons";
import { SCREENS } from "./sidebar-screens";

/** One screen the sidebar names: its icon, its name, and how many things there wait on the person, when any do. */
function NavRow({ icon, label, count = 0, current, pressed, onClick }: { icon: ReactNode; label: string; count?: number; current?: boolean; pressed?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      aria-pressed={pressed}
      aria-label={count ? `${label}, ${count} waiting` : undefined}
      className="sidebar-nav-row no-drag"
      onClick={() => {
        onClick();
        dismissCompactNavigation();
      }}
    >
      <span className="sidebar-nav-icon">{icon}</span>
      <span className="sidebar-nav-label">{label}</span>
      {count ? <span className="sidebar-count tabular">{count > 99 ? "99+" : count}</span> : null}
    </button>
  );
}

/** Orclings' chats, their own and their groups', that wait on the person. */
function useWaitingOrclings(): number {
  const homes = useOrclingChatIds();
  const rows = useRpc(
    "threads.list",
    { projectIds: [WORKSPACE_ID], filter: "active", orderBy: "activity", includeChildren: false, needsYou: true, limit: NEEDS_YOU_PAGE },
    { enabled: homes.size > 0, refetchInterval: 60_000 },
  );
  return (rows.data ?? []).filter((thread) => homes.has(thread.id) && waitsOnYou(threadStatus(thread))).length;
}

/**
 * The app's screens by name: Tasks, Pull requests and Schedules, then Orclings, which swaps the threads below for the
 * Orclings and back, then the Inbox. A count shows only where something waits on the person.
 */
export function SidebarNav({ route, orclings }: { route: Route; orclings: { active: boolean; toggle: () => void } }) {
  const tasks = waitingTaskCount(useRpc("tasks.list", {}).data ?? []);
  const counts: Partial<Record<SidebarScreen, number>> = { tasks };
  const waitingOrclings = useWaitingOrclings();
  // The Inbox holds approvals in the runs loaded here, and the same waiting tasks.
  const inbox = usePendingApprovals() + tasks;
  return (
    <nav className="sidebar-nav" aria-label="Screens">
      {SCREENS.map(({ id, label, Icon, route: to, views }) => (
        <NavRow key={id} icon={<Icon size={16} />} label={label} count={counts[id]} current={views.includes(route.view)} onClick={() => useRouter.getState().navigate(to)} />
      ))}
      <NavRow icon={<Orclings size={16} />} label="Orclings" count={waitingOrclings} pressed={orclings.active} onClick={orclings.toggle} />
      <NavRow icon={<Inbox size={16} />} label="Inbox" count={inbox} current={route.view === "inbox"} onClick={() => useRouter.getState().navigate({ view: "inbox" })} />
    </nav>
  );
}
