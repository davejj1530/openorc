import { useRef, type ReactNode } from "react";
import type { SidebarScreen } from "../lib/layout";
import { Inbox, PenSquare, Settings } from "./icons";
import { AccountUsage } from "./AccountUsage";
import { usePendingApprovals, useRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { newThread, useRouter, type Route } from "../lib/router";
import { cn } from "../lib/cn";
import { activeScheduleCount, openTaskCount } from "../lib/task-stage-counts";
import { useSlidingKnob } from "../lib/use-sliding-knob";
import { RAIL_ICON, SCREENS } from "./sidebar-screens";
import { RailProjects } from "./SidebarRailProjects";
import { RailOrclings } from "./SidebarRailOrclings";
import { RailUpdate } from "./SidebarRailUpdate";
import { CountBadge, Tooltip } from "./ui";

/** What a screen's button says beside its name: open tasks, and schedules that are switched on. */
function useScreenNotes(): Partial<Record<SidebarScreen, string>> {
  const tasks = openTaskCount(useRpc("tasks.list", {}).data ?? []);
  const schedules = activeScheduleCount(useRpc("schedules.list", {}).data ?? []);
  return { ...(tasks ? { tasks: `${tasks} open` } : {}), ...(schedules ? { scheduled: `${schedules} on` } : {}) };
}

function RailButton({
  label,
  name = label,
  current,
  pressed,
  className,
  onClick,
  children,
}: {
  label: string;
  /** What a screen reader hears, when it says more than the tooltip. */
  name?: string;
  current?: boolean;
  pressed?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={name}
        aria-current={current ? "page" : undefined}
        aria-pressed={pressed}
        data-current={current || pressed || undefined}
        className={cn("sidebar-dock-button no-drag", className)}
        onClick={() => {
          onClick();
          dismissCompactNavigation();
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** What waits for the user: approvals in the runs loaded here, and tasks to review or accept. */
function useInboxCount(): number {
  const approvals = usePendingApprovals();
  const tasks = useRpc("tasks.list", {});
  return approvals + (tasks.data ?? []).filter((task) => task.status === "review" || task.status === "proposed").length;
}

/** Opens the Inbox page, with what waits in it counted on the icon's corner. */
function RailInbox({ current }: { current: boolean }) {
  const count = useInboxCount();
  return (
    <RailButton label="Inbox" name={count ? `Inbox, ${count}` : "Inbox"} current={current} className="sidebar-rail-inbox" onClick={() => useRouter.getState().navigate({ view: "inbox" })}>
      <Inbox size={RAIL_ICON} />
      {count ? <CountBadge count={count} size="sm" className="sidebar-rail-badge" /> : null}
    </RailButton>
  );
}

/**
 * The rail beside the thread list: the app's screens as round buttons with Orclings among them, then Projects, which
 * lists the projects under it while open, then Inbox, then the week's usage, the update and Settings at its foot. New thread
 * leads it, for the project the list focuses. The current screen sits on a knob that slides
 * between them. Orclings switches the list beside it between project threads and Orclings.
 */
export function SidebarRail({
  route,
  orclings,
  onProject,
  projectId,
}: {
  route: Route;
  orclings: { active: boolean; toggle: () => void };
  onProject: (workspace: string) => void;
  /** The project a new thread starts in: the one the filter focuses. */
  projectId: string | null;
}) {
  const notes = useScreenNotes();
  const rail = useRef<HTMLElement>(null);
  const knob = useSlidingKnob(rail, "[data-current]", `${route.view}:${orclings.active}`);
  return (
    <nav ref={rail} className="sidebar-rail" aria-label="Screens">
      <span aria-hidden="true" className="sidebar-dock-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
      <RailButton label="New thread" current={route.view === "newthread"} onClick={() => newThread(projectId ?? undefined)}>
        <PenSquare size={RAIL_ICON} />
      </RailButton>
      {SCREENS.map(({ id, label, Icon, route: to, views }) => (
        <RailButton key={id} label={notes[id] ? `${label} · ${notes[id]}` : label} current={views.includes(route.view)} onClick={() => useRouter.getState().navigate(to)}>
          <Icon size={RAIL_ICON} />
        </RailButton>
      ))}
      <RailOrclings active={orclings.active} toggle={orclings.toggle} threadId={route.view === "thread" ? route.threadId : null} />
      <span aria-hidden="true" className="sidebar-rail-divider" />
      <RailProjects onSelect={onProject} />
      <span aria-hidden="true" className="sidebar-rail-divider" />
      <RailInbox current={route.view === "inbox"} />
      <span aria-hidden="true" className="sidebar-rail-gap" />
      <AccountUsage />
      <RailUpdate />
      <RailButton label="Settings" current={route.view === "settings"} onClick={() => useRouter.getState().navigate({ view: "settings" })}>
        <Settings size={RAIL_ICON} />
      </RailButton>
    </nav>
  );
}
