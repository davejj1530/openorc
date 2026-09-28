import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const preference = window.matchMedia(REDUCED_MOTION_QUERY);
  preference.addEventListener("change", onChange);
  return () => preference.removeEventListener("change", onChange);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The system reduced-motion setting, following changes while mounted. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion);
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
