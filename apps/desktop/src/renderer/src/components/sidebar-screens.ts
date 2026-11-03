import type { SidebarScreen } from "../lib/layout";
import type { Route } from "../lib/router";
import { Brain, CalendarClock, GitPullRequest, ListTodo } from "./icons";

export interface Screen {
  id: SidebarScreen;
  label: string;
  Icon: typeof ListTodo;
  route: (projectId: string | null) => Route;
  /** The views that belong to the screen, so it reads as current on any of them. */
  views: Route["view"][];
}

/** The screens in the order the sidebar lists them. */
export const SCREENS: Screen[] = [
  { id: "tasks", label: "Tasks", Icon: ListTodo, route: () => ({ view: "tasks" }), views: ["tasks", "task", "newtask"] },
  { id: "pulls", label: "Pull requests", Icon: GitPullRequest, route: () => ({ view: "pulls" }), views: ["pulls", "pull"] },
  { id: "scheduled", label: "Schedules", Icon: CalendarClock, route: () => ({ view: "scheduled" }), views: ["scheduled"] },
  { id: "memory", label: "Memory", Icon: Brain, route: () => ({ view: "memory" }), views: ["memory"] },
];
