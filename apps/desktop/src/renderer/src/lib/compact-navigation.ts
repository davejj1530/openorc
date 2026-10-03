import { useLayout } from "./layout";

/** On compact windows, navigation overlays the page and dismisses after opening it. */
export function dismissCompactNavigation() {
  const layout = useLayout.getState();
  if (layout.sidebarOpen && window.matchMedia("(max-width: 900px)").matches) layout.toggleSidebar();
}
