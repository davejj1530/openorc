import { useSyncExternalStore } from "react";
import { useLayout } from "./layout";

/** Windows this narrow float the sidebar over the page instead of setting it beside it (sidebar.css). */
const COMPACT_WINDOW = "(max-width: 900px)";

const compact = () => typeof window.matchMedia === "function" && window.matchMedia(COMPACT_WINDOW).matches;

/** Whether the window is narrow enough for navigation to float over the page. */
export function useCompactWindow(): boolean {
  return useSyncExternalStore((change) => {
    if (typeof window.matchMedia !== "function") return () => {};
    const media = window.matchMedia(COMPACT_WINDOW);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, compact);
}

/** On compact windows, navigation overlays the page and dismisses after opening it. */
export function dismissCompactNavigation() {
  const layout = useLayout.getState();
  if (layout.sidebarOpen && compact()) layout.toggleSidebar();
}
