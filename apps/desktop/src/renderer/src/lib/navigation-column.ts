import { useCompactWindow } from "./compact-navigation";
import { useLayout } from "./layout";
import { useTrafficLights } from "./window";

/**
 * Whether nothing of the navigation column shows, so the first header meets the window's left edge. Hidden, the sidebar
 * keeps its rail, except in a narrow window, where it floats.
 */
export function useNavigationGone(): boolean {
  const open = useLayout((s) => s.sidebarOpen);
  const compact = useCompactWindow();
  return !open && compact;
}

export type HeaderCorner = "lights" | "rail-lights" | "wordmark" | null;

/** The start padding that clears what holds the window's corner beside a header. */
export const cornerInset: Record<NonNullable<HeaderCorner>, string> = { lights: "pl-traffic", "rail-lights": "pl-rail-lights", wordmark: "pl-wordmark" };

/**
 * What the first header beside the navigation leaves room for at its start: the traffic lights, when it meets the
 * window's edge; the part of them that reaches past the folded rail; the wordmark, when the folded rail keeps it in a
 * corner no traffic lights hold (full screen, and off macOS), where it overhangs the header just as it sits over the
 * open sidebar; else nothing.
 */
export function useWindowCorner(): HeaderCorner {
  const open = useLayout((s) => s.sidebarOpen);
  const gone = useNavigationGone();
  const trafficLights = useTrafficLights();
  if (gone) return trafficLights ? "lights" : null;
  if (open) return null;
  return trafficLights ? "rail-lights" : "wordmark";
}
