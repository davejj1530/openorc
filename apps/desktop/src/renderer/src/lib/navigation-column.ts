import { useCompactWindow } from "./compact-navigation";
import { useLayout } from "./layout";
import { useTrafficLights } from "./window";

/** Whether the sidebar is hidden, so nothing of it shows or takes focus. */
export function useNavigationGone(): boolean {
  return useLayout((s) => !s.sidebarOpen);
}

export type HeaderCorner = "lights" | null;

/** The start padding that clears what holds the window's corner beside a header. */
export const cornerInset: Record<NonNullable<HeaderCorner>, string> = { lights: "pl-traffic" };

/**
 * What the first header leaves room for at its start: the traffic lights, whenever it meets the window's left edge,
 * which is while the sidebar is hidden or floats over a narrow window.
 */
export function useWindowCorner(): HeaderCorner {
  const gone = useNavigationGone();
  const compact = useCompactWindow();
  const trafficLights = useTrafficLights();
  return (gone || compact) && trafficLights ? "lights" : null;
}
