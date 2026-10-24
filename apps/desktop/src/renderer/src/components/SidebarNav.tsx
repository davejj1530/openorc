import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, MoreHorizontal, PenSquare, SlidersHorizontal } from "./icons";
import { useLayout, type SidebarScreen } from "../lib/layout";
import { useRpc } from "../lib/client";
import { newThread, useRouter, type Route } from "../lib/router";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { activeScheduleCount, openTaskCount } from "../lib/task-stage-counts";
import { useSlidingKnob } from "../lib/use-sliding-knob";
import { SidebarEdit } from "./SidebarEdit";
import { SCREENS, type Screen } from "./sidebar-screens";

/** A sidebar row: a 16px muted glyph, the label, and an optional faint count. */
export function NavItem({ route, icon, label, active, count }: { route: Route; icon: ReactNode; label: string; active: boolean; count?: number }) {
  const navigate = useRouter((s) => s.navigate);
  return (
    <button
      type="button"
      onClick={() => {
        navigate(route);
        dismissCompactNavigation();
      }}
      aria-current={active ? "page" : undefined}
      className="nav-row sidebar-nav-row no-drag"
    >
      <span className="sidebar-nav-icon">{icon}</span>
      <span className="sidebar-nav-label">{label}</span>
      {count ? <span className="sidebar-nav-count tabular">{count}</span> : null}
    </button>
  );
}

/** The counts a screen row carries: open tasks, and schedules that are switched on. */
function useScreenCounts(): Partial<Record<SidebarScreen, number>> {
  const tasks = useRpc("tasks.list", {});
  const schedules = useRpc("schedules.list", {});
  return { tasks: openTaskCount(tasks.data ?? []), scheduled: activeScheduleCount(schedules.data ?? []) };
}

/**
 * The app's screens above the projects: New thread, the screens the user lists, then More, which
 * unfolds in place to the rest and to Edit sidebar, a dialog of switches. The current row's fill is
 * one knob that slides.
 */
export function SidebarNav({ route, projectId }: { route: Route; projectId: string | null }) {
  const hidden = useLayout((s) => s.hiddenScreens);
  const counts = useScreenCounts();
  const [editing, setEditing] = useState(false);
  const track = useRef<HTMLElement>(null);
  const knob = useSlidingKnob(track, '[aria-current="page"]', `${route.view}:${hidden.join()}`);
  const row = ({ id, label, Icon, route: to, views }: Screen) => (
    <NavItem key={id} route={to(projectId)} icon={<Icon size={16} />} label={label} active={views.includes(route.view)} count={counts[id]} />
  );
  return (
    <nav ref={track} className="sidebar-nav" aria-label="Screens">
      <span aria-hidden="true" className="sidebar-nav-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
      <button
        type="button"
        className="nav-row sidebar-nav-row sidebar-new-thread no-drag"
        onClick={() => {
          newThread(projectId ?? undefined);
          dismissCompactNavigation();
        }}
      >
        <span className="sidebar-nav-icon">
          <PenSquare size={16} />
        </span>
        <span className="sidebar-nav-label">New thread</span>
      </button>
      {SCREENS.filter((screen) => !hidden.includes(screen.id)).map(row)}
      <MoreScreens screens={SCREENS.filter((screen) => hidden.includes(screen.id))} route={route} onEdit={() => setEditing(true)}>
        {SCREENS.filter((screen) => hidden.includes(screen.id)).map(row)}
      </MoreScreens>
      <SidebarEdit open={editing} onOpenChange={setEditing} />
    </nav>
  );
}

/**
 * The screens the user hid, unfolding in place under More, and the way to the Edit sidebar dialog.
 * More reads as current while one of its screens is open and it is folded.
 */
function MoreScreens({ screens, route, onEdit, children }: { screens: Screen[]; route: Route; onEdit: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const current = !open && screens.some((screen) => screen.views.includes(route.view));
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        aria-current={current ? "page" : undefined}
        onClick={() => setOpen(!open)}
        className="nav-row sidebar-nav-row sidebar-more-toggle no-drag"
      >
        <span className="sidebar-nav-icon">
          <MoreHorizontal size={16} />
        </span>
        <span className="sidebar-nav-label">More</span>
        <ChevronDown size={14} className="sidebar-more-chevron" />
      </button>
      <div id={contentId} className="sidebar-more" data-open={open || undefined} inert={!open} aria-hidden={!open}>
        <div className="sidebar-more-rows">
          {children}
          <button type="button" className="nav-row sidebar-nav-row sidebar-edit-entry no-drag" onClick={onEdit}>
            <span className="sidebar-nav-icon">
              <SlidersHorizontal size={16} />
            </span>
            <span className="sidebar-nav-label">Edit sidebar</span>
          </button>
        </div>
      </div>
    </>
  );
}
