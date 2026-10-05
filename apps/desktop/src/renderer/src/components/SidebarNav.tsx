import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Brain, CalendarClock, GitPullRequest, ListTodo, MoreHorizontal, Workflow } from "./icons";
import { cn } from "../lib/cn";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout, type SidebarScreen } from "../lib/layout";
import { useRouter, type Route } from "../lib/router";
import { menuItem, menuPopup } from "./ThreadActions";
import { Dialog, Switch, Tooltip } from "./ui";
import { dismissCompactNavigation } from "../lib/compact-navigation";

const navRow = "nav-row no-drag w-full flex items-center gap-3 h-9 px-2 rounded-md text-md font-normal text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink";

export function NavItem({ route, icon, label, active, rail = false }: { route: Route; icon: ReactNode; label: string; active: boolean; rail?: boolean }) {
  const navigate = useRouter((s) => s.navigate);
  const button = (
    <button
      onClick={() => {
        navigate(route);
        dismissCompactNavigation();
      }}
      aria-label={rail ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(rail ? "workspace-rail-button" : navRow, active && "text-ink")}
    >
      <span className={cn("text-ink-3", active && "text-ink")}>{icon}</span>
      {rail ? null : <span className="flex-1 text-left truncate">{label}</span>}
    </button>
  );
  return rail ? <Tooltip label={label}>{button}</Tooltip> : button;
}

interface Screen {
  id: SidebarScreen;
  label: string;
  Icon: typeof ListTodo;
  route: (projectId: string | null) => Route;
  /** The views that belong to the screen, so it reads as current on any of them. */
  views: Route["view"][];
}

/** The screens in the order the sidebar lists them. */
const SCREENS: Screen[] = [
  { id: "tasks", label: "Tasks", Icon: ListTodo, route: () => ({ view: "tasks" }), views: ["tasks", "task", "newtask"] },
  { id: "pulls", label: "Pull requests", Icon: GitPullRequest, route: () => ({ view: "pulls" }), views: ["pulls", "pull"] },
  { id: "scheduled", label: "Schedules", Icon: CalendarClock, route: () => ({ view: "scheduled" }), views: ["scheduled"] },
  { id: "orchestration", label: "Orchestration", Icon: Workflow, route: (projectId) => ({ view: "orchestration", ...(projectId ? { projectId } : {}) }), views: ["orchestration"] },
  { id: "memory", label: "Memory", Icon: Brain, route: () => ({ view: "memory" }), views: ["memory"] },
];

/** The app's screens above the projects: the ones the user lists, then More for the rest. */
export function SidebarNav({ route, projectId, rail = false }: { route: Route; projectId: string | null; rail?: boolean }) {
  const hidden = useLayout((s) => s.hiddenScreens);
  const Container = rail ? "div" : "nav";
  return (
    <Container className={rail ? "flex flex-col gap-1" : "nav-track grid grid-cols-1 min-w-0 gap-px"}>
      {SCREENS.filter((screen) => !hidden.includes(screen.id)).map(({ id, label, Icon, route: to, views }) => (
        <NavItem key={id} route={to(projectId)} icon={<Icon size={rail ? 19 : 15} />} label={label} active={views.includes(route.view)} rail={rail} />
      ))}
      <MoreScreens screens={SCREENS.filter((screen) => hidden.includes(screen.id))} route={route} projectId={projectId} rail={rail} />
    </Container>
  );
}

/** The screens the user hid, and the way to choose which ones the sidebar lists. It reads as current while one of its screens is open. */
function MoreScreens({ screens, route, projectId, rail }: { screens: Screen[]; route: Route; projectId: string | null; rail: boolean }) {
  const navigate = useRouter((s) => s.navigate);
  const [editing, setEditing] = useState(false);
  const current = screens.some((screen) => screen.views.includes(route.view));
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label={rail ? "More" : undefined}
          title={rail ? "More" : undefined}
          aria-current={current ? "page" : undefined}
          className={cn(rail ? "workspace-rail-button" : navRow, current && "text-ink")}
        >
          <span className={cn("text-ink-3", current && "text-ink")}>
            <MoreHorizontal size={rail ? 19 : 15} />
          </span>
          {rail ? null : <span className="flex-1 text-left truncate">More</span>}
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner side="right" align="start" sideOffset={8} className="z-40" collisionPadding={8}>
            <Menu.Popup className={menuPopup}>
              {screens.map(({ id, label, Icon, route: to }) => (
                <Menu.Item
                  key={id}
                  className={menuItem}
                  onClick={() => {
                    navigate(to(projectId));
                    dismissCompactNavigation();
                  }}
                >
                  <Icon size={14} className="text-ink-3" />
                  {label}
                </Menu.Item>
              ))}
              {screens.length ? <Menu.Separator className="my-1 h-px bg-line" /> : null}
              <Menu.Item className={menuItem} onClick={() => setEditing(true)}>
                Edit sidebar…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <EditSidebar open={editing} onOpenChange={setEditing} />
    </>
  );
}

/** Which screens the sidebar lists; each one switched off waits under More. */
function EditSidebar({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const hidden = useLayout((s) => s.hiddenScreens);
  const setScreenShown = useLayout((s) => s.setScreenShown);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Edit sidebar" width={360}>
      <div className="grid gap-px">
        {SCREENS.map(({ id, label, Icon }) => (
          <label key={id} className="flex items-center gap-3 h-9 px-2 rounded-md cursor-pointer hover:bg-surface-2">
            <Icon size={15} className="text-ink-3" />
            <span className="flex-1 text-base text-ink">{label}</span>
            <Switch checked={!hidden.includes(id)} onChange={(event) => setScreenShown(id, event.target.checked)} />
          </label>
        ))}
      </div>
    </Dialog>
  );
}
