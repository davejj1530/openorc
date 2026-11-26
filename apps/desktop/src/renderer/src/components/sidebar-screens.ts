import type { SidebarScreen } from "../lib/layout";
import type { Route } from "../lib/router";
import { Automation, GitPullRequest, ListTodo } from "./icons";

export interface Screen {
  id: SidebarScreen;
  label: string;
  Icon: typeof ListTodo;
  route: Route;
  /** The views that belong to the screen, so it reads as current on any of them. */
  views: Route["view"][];
}

/** The screens in the order the sidebar lists them. */
export const SCREENS: Screen[] = [
  { id: "tasks", label: "Tasks", Icon: ListTodo, route: { view: "tasks" }, views: ["tasks", "task", "newtask"] },
  { id: "pulls", label: "Pull requests", Icon: GitPullRequest, route: { view: "pulls" }, views: ["pulls", "pull"] },
  { id: "scheduled", label: "Automations", Icon: Automation, route: { view: "scheduled" }, views: ["scheduled"] },
];
