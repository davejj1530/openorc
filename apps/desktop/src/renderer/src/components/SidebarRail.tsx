import { useRef, type ReactNode } from "react";
import type { SidebarScreen } from "../lib/layout";
import { Orclings, Settings } from "./icons";
import { useRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter, type Route } from "../lib/router";
import { activeScheduleCount, openTaskCount } from "../lib/task-stage-counts";
import { useSlidingKnob } from "../lib/use-sliding-knob";
import { RAIL_ICON, SCREENS } from "./sidebar-screens";
import { RailProjects } from "./SidebarRailProjects";
import { RailUpdate } from "./SidebarRailUpdate";
import { Tooltip } from "./ui";

/** What a screen's button says beside its name: open tasks, and schedules that are switched on. */
function useScreenNotes(): Partial<Record<SidebarScreen, string>> {
  const tasks = openTaskCount(useRpc("tasks.list", {}).data ?? []);
  const schedules = activeScheduleCount(useRpc("schedules.list", {}).data ?? []);
  return { ...(tasks ? { tasks: `${tasks} open` } : {}), ...(schedules ? { scheduled: `${schedules} on` } : {}) };
}

function RailButton({ label, current, pressed, onClick, children }: { label: string; current?: boolean; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-current={current ? "page" : undefined}
        aria-pressed={pressed}
        data-current={current || pressed || undefined}
        className="sidebar-dock-button no-drag"
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

/**
 * The rail beside the thread list: the app's screens as round buttons with Orclings among them, then Projects, which
 * lists the projects under it while open, and Settings at its foot. The current screen sits on a knob that slides
 * between them. Orclings switches the list beside it between project threads and Orclings.
 */
export function SidebarRail({ route, orclings, onProject }: { route: Route; orclings: { active: boolean; toggle: () => void }; onProject: (workspace: string) => void }) {
  const notes = useScreenNotes();
  const rail = useRef<HTMLElement>(null);
  const knob = useSlidingKnob(rail, "[data-current]", `${route.view}:${orclings.active}`);
  return (
    <nav ref={rail} className="sidebar-rail" aria-label="Screens">
      <span aria-hidden="true" className="sidebar-dock-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
      {SCREENS.map(({ id, label, Icon, route: to, views }) => (
        <RailButton key={id} label={notes[id] ? `${label} · ${notes[id]}` : label} current={views.includes(route.view)} onClick={() => useRouter.getState().navigate(to)}>
          <Icon size={RAIL_ICON} />
        </RailButton>
      ))}
      <RailButton label="Orclings" pressed={orclings.active} onClick={orclings.toggle}>
        <Orclings size={RAIL_ICON} />
      </RailButton>
      <span aria-hidden="true" className="sidebar-rail-divider" />
      <RailProjects onSelect={onProject} />
      <span aria-hidden="true" className="sidebar-rail-gap" />
      <RailUpdate />
      <RailButton label="Settings" onClick={() => useRouter.getState().navigate({ view: "settings" })}>
        <Settings size={RAIL_ICON} />
      </RailButton>
    </nav>
  );
}
