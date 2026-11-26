import { Automation, Brain, FileCode2, FolderPlus, ListTodo, Moon, PenSquare, Plus, Settings, Sun, SunMoon } from "../components/icons";
import { fileTarget, focusedThread } from "./files-tool";
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
  { label: "New thread", icon: PenSquare, run: () => newThread() },
  { label: "New task", icon: Plus, run: () => useUi.getState().openNewTask() },
  {
    label: "New file",
    icon: FileCode2,
    available: () => fileTarget(focusedThread()) !== null,
    run: () => useUi.getState().setNewFile(fileTarget(focusedThread())),
  },
  { label: "Add project", icon: FolderPlus, run: () => useUi.getState().setImportProject(true) },
  { label: "All tasks", icon: ListTodo, run: () => go({ view: "tasks" }) },
  { label: "Automations", icon: Automation, run: () => go({ view: "scheduled" }) },
  { label: "Memory", icon: Brain, run: () => go({ view: "memory" }) },
  { label: "Settings", icon: Settings, run: () => go({ view: "settings" }) },
  { label: "Theme: light", icon: Sun, run: () => useTheme.getState().set("light") },
  { label: "Theme: dark", icon: Moon, run: () => useTheme.getState().set("dark") },
  { label: "Theme: system", icon: SunMoon, run: () => useTheme.getState().set("system") },
];
