import { useLayout } from "./layout";
import { useRouter } from "./router";

/**
 * Whether nothing of the navigation column shows, so the first header meets the window's left edge. Hidden, the sidebar
 * keeps its rail, except in Settings, which takes the whole column over.
 */
export function useNavigationGone(): boolean {
  const open = useLayout((s) => s.sidebarOpen);
  const settings = useRouter((s) => s.route.view === "settings");
  return !open && settings;
}
