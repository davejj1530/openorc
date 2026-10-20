import { CalendarClock, FileCode2, FolderGit2, ListTodo, MessageSquare, Moon, Plus, Settings, Sun, SunMoon, Workflow } from "../components/icons";
import { fileTarget, focusedThread } from "./files-tool";
import { useLayout } from "./layout";
import { newThread, useRouter, type Route } from "./router";
import { useTheme } from "./theme";
import { useUi } from "./ui";

export interface PaletteAction {
  label: string;
  icon: typeof Plus;
  run: () => void;
  /** Left out of the palette while this says no. */
  available?: () => boolean;
}

const go = (route: Route) => useRouter.getState().navigate(route);

/** The command palette's Actions group, in the order it lists them. */
export const paletteActions: readonly PaletteAction[] = [
  { label: "New thread", icon: MessageSquare, run: () => newThread() },
  { label: "New task", icon: Plus, run: () => useUi.getState().openNewTask() },
  {
    label: "New file",
    icon: FileCode2,
    available: () => fileTarget(focusedThread()) !== null,
    run: () => useUi.getState().setNewFile(fileTarget(focusedThread())),
  },
  { label: "Import project", icon: FolderGit2, run: () => useUi.getState().setImportProject(true) },
  { label: "All tasks", icon: ListTodo, run: () => go({ view: "tasks" }) },
  { label: "Schedules", icon: CalendarClock, run: () => go({ view: "scheduled" }) },
  { label: "Teams", icon: Workflow, run: () => go({ view: "orchestration", projectId: useLayout.getState().projectId ?? undefined }) },
  { label: "Settings", icon: Settings, run: () => go({ view: "settings" }) },
  { label: "Theme: light", icon: Sun, run: () => useTheme.getState().set("light") },
  { label: "Theme: dark", icon: Moon, run: () => useTheme.getState().set("dark") },
  { label: "Theme: system", icon: SunMoon, run: () => useTheme.getState().set("system") },
];
