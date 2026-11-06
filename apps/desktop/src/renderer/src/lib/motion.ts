import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

/**
 * The shape-resize duration, --duration-resize in app.css. The panel shell animates its width
 * over it, and Panel keeps the pane mounted exactly this long after it closes.
 */
export const PANE_MS = 420;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const preference = window.matchMedia(REDUCED_MOTION_QUERY);
  preference.addEventListener("change", onChange);
  return () => preference.removeEventListener("change", onChange);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The system reduced-motion setting, following changes while mounted. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion);
}

/**
 * Applies a change that swaps a screen's content in place, as a view transition of the given type. The
 * screen's CSS names its parts only while that type runs (:active-view-transition-type), so the parts
 * cross-fade where they stand and glide to where they land, even across a remount. Under reduced
 * motion, or where view transitions are missing, the change applies at once.
 */
export function swapInPlace(type: string, change: () => void): void {
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    change();
    return;
  }
  document.startViewTransition({ update: () => flushSync(change), types: [type] });
}

/**
 * Reports whether an element can be seen: it intersects the viewport and the
 * page is not hidden. Decorative motion pauses otherwise. Returns the function
 * that stops observing.
 */
export function observeOnScreen(element: Element, onChange: (onScreen: boolean) => void): () => void {
  let intersecting = false;
  const report = () => onChange(intersecting && !document.hidden);
  const viewport = new IntersectionObserver((entries) => {
    // Entries queued between callbacks arrive oldest first; the newest is current.
    intersecting = entries.at(-1)?.isIntersecting ?? false;
    report();
  });
  viewport.observe(element);
  document.addEventListener("visibilitychange", report);
  return () => {
    viewport.disconnect();
    document.removeEventListener("visibilitychange", report);
  };
}
