import type { ReactNode } from "react";
import { useRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import type { SidebarScreen } from "../lib/layout";
import { useOrganizationStart } from "../lib/organization-start";
import { useFrozenWork } from "../lib/organization-frozen-work";
import { newThread, useRouter, type Route } from "../lib/router";
import { useTaskAttentionCount } from "../lib/task-list-source";
import { PenSquare } from "./icons";
import { SCREENS } from "./sidebar-screens";

type NavRowProps = { icon: ReactNode; label: string; count?: number; lead?: boolean; current?: boolean; onClick: () => void };

/** One screen the sidebar names: its icon, its name, and how many things there wait on the person, when any do. A lead
 * row, the one that starts work, keeps full ink at rest. */
function NavRow({ icon, label, count = 0, lead, current, onClick }: NavRowProps) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
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

/**
 * New thread first, lit while its screen is open, then the app's screens by name: Tasks, Pull requests and Automations.
 * A count shows only where something waits on the person; what a thread waits for shows on its own row and its
 * project's label.
 */
export function SidebarNav({ route, projectId }: { route: Route; projectId: string | null }) {
  const tasks = useTaskAttentionCount();
  // An automation an agent wrote waits on the person until they turn it on or dismiss it.
  const proposed = useRpc("automations.list", {}).data?.filter((automation) => automation.proposed).length ?? 0;
  const counts: Partial<Record<SidebarScreen, number>> = { tasks, scheduled: proposed };
  // The organization's own page or its frozen screen stands in for the route's screen, so no row is lit.
  const organizationPage = useOrganizationStart(route.view === "newthread" ? route.projectId : null);
  const frozen = useFrozenWork(route);
  const standIn = organizationPage || frozen !== null;
  return (
    <nav className="sidebar-nav" aria-label="Screens">
      <NavRow icon={<PenSquare size={18} />} label="New thread" lead current={route.view === "newthread" && !standIn} onClick={() => newThread(projectId ?? undefined)} />
      {SCREENS.map(({ id, label, Icon, route: to, views }) => (
        <NavRow key={id} icon={<Icon size={18} />} label={label} count={counts[id]} current={!standIn && views.includes(route.view)} onClick={() => useRouter.getState().navigate(to)} />
      ))}
    </nav>
  );
}
