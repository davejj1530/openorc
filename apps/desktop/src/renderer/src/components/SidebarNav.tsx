import type { ReactNode } from "react";
import { NEEDS_YOU_PAGE, threadStatus, waitsOnYou } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { useSpaceRpc as useRpc } from "../lib/space-queries";
import { useRpc as useGlobalRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import type { SidebarScreen } from "../lib/layout";
import { useOrclingChatIds } from "../lib/orclings";
import { newThread, useRouter, type Route } from "../lib/router";
import { waitingTaskCount } from "../lib/task-stage-counts";
import { Orclings, PenSquare } from "./icons";
import { SCREENS } from "./sidebar-screens";

type NavRowProps = { icon: ReactNode; label: string; count?: number; lead?: boolean; current?: boolean; pressed?: boolean; onClick: () => void };

/** One screen the sidebar names: its icon, its name, and how many things there wait on the person, when any do. A lead
 * row, the one that starts work, keeps full ink at rest. */
function NavRow({ icon, label, count = 0, lead, current, pressed, onClick }: NavRowProps) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      aria-pressed={pressed}
      aria-label={count ? `${label}, ${count} waiting` : undefined}
      data-lead={lead || undefined}
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
  const rows = useGlobalRpc(
    "threads.list",
    { projectIds: [WORKSPACE_ID], filter: "active", orderBy: "activity", includeChildren: false, needsYou: true, limit: NEEDS_YOU_PAGE },
    { enabled: homes.size > 0, refetchInterval: 60_000 },
  );
  return (rows.data ?? []).filter((thread) => homes.has(thread.id) && waitsOnYou(threadStatus(thread))).length;
}

/**
 * New thread first, lit while its screen is open, then the app's screens by name: Tasks, Pull requests and Schedules, then Orclings, which swaps the threads below for the
 * Orclings and back, with their tools at its end while it does. A count shows only where something waits on the person;
 * what a thread waits for shows on its own row and its project's label.
 */
export function SidebarNav({ route, projectId, orclings }: { route: Route; projectId: string | null; orclings: { active: boolean; toggle: () => void; tools: ReactNode } }) {
  const tasks = waitingTaskCount(useRpc("tasks.list", {}).data ?? []);
  const counts: Partial<Record<SidebarScreen, number>> = { tasks };
  const waitingOrclings = useWaitingOrclings();
  return (
    <nav className="sidebar-nav" aria-label="Screens">
      <NavRow icon={<PenSquare size={16} />} label="New thread" lead current={route.view === "newthread"} onClick={() => newThread(projectId ?? undefined)} />
      {SCREENS.map(({ id, label, Icon, route: to, views }) => (
        <NavRow key={id} icon={<Icon size={16} />} label={label} count={counts[id]} current={views.includes(route.view)} onClick={() => useRouter.getState().navigate(to)} />
      ))}
      {/* Pressed, the Orclings take the threads' place under it, and its row's end carries their tools. */}
      <div className="sidebar-nav-item">
        <NavRow icon={<Orclings size={16} />} label="Orclings" count={orclings.active ? 0 : waitingOrclings} pressed={orclings.active} onClick={orclings.toggle} />
        {orclings.active ? <div className="sidebar-nav-tools">{orclings.tools}</div> : null}
      </div>
    </nav>
  );
}
