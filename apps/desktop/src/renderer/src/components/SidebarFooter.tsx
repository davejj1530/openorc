import { useRef, type ReactNode } from "react";
import type { SidebarScreen } from "../lib/layout";
import { AccountUsage } from "./AccountUsage";
import { Orclings, Settings } from "./icons";
import { useRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter, type Route } from "../lib/router";
import { activeScheduleCount, openTaskCount } from "../lib/task-stage-counts";
import { useSlidingKnob } from "../lib/use-sliding-knob";
import { SCREENS } from "./sidebar-screens";
import { Tooltip } from "./ui";

/** What a screen's button says beside its name: open tasks, and schedules that are switched on. */
function useScreenNotes(): Partial<Record<SidebarScreen, string>> {
  const tasks = openTaskCount(useRpc("tasks.list", {}).data ?? []);
  const schedules = activeScheduleCount(useRpc("schedules.list", {}).data ?? []);
  return { ...(tasks ? { tasks: `${tasks} open` } : {}), ...(schedules ? { scheduled: `${schedules} on` } : {}) };
}

function DockButton({ label, current, pressed, onClick, children }: { label: string; current?: boolean; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
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
 * The open thread's weekly usage, then the app's screens as round buttons with Orclings among them and Settings at
 * the end. The current one sits on a knob that slides between them. Orclings switches the list above between project
 * threads and Orclings. Settings already fills the sidebar, so while it is open the footer steps away.
 */
export function SidebarFooter({ route, projectId, orclings }: { route: Route; projectId: string | null; orclings: { active: boolean; toggle: () => void } }) {
  const notes = useScreenNotes();
  const dock = useRef<HTMLElement>(null);
  const knob = useSlidingKnob(dock, "[data-current]", `${route.view}:${orclings.active}`);
  if (route.view === "settings") return null;
  return (
    <footer className="sidebar-footer">
      <AccountUsage />
      <nav ref={dock} className="sidebar-dock" aria-label="Screens">
        <span aria-hidden="true" className="sidebar-dock-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
        {SCREENS.map(({ id, label, Icon, route: to, views }) => (
          <DockButton key={id} label={notes[id] ? `${label} · ${notes[id]}` : label} current={views.includes(route.view)} onClick={() => useRouter.getState().navigate(to(projectId))}>
            <Icon size={16} />
          </DockButton>
        ))}
        <DockButton label="Orclings" pressed={orclings.active} onClick={orclings.toggle}>
          <Orclings size={16} />
        </DockButton>
        <span className="flex-1" />
        <DockButton label="Settings" onClick={() => useRouter.getState().navigate({ view: "settings" })}>
          <Settings size={16} />
        </DockButton>
      </nav>
    </footer>
  );
}
