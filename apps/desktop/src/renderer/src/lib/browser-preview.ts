import { useEffect } from "react";
import { create } from "zustand";

/** Listen only while this conversation owns the shared sidebar. */
export function useBrowserPreview(surface: string | null, reveal: () => void): void {
  useEffect(() => {
    const browser = window.openorc.browser;
    // A hot-reloaded renderer can precede the new preload during development.
    if (!browser?.onReveal) return;
    const off = browser.onReveal((id) => {
      if (id === surface) reveal();
    });
    browser.setContext(surface);
    return () => {
      off();
      browser.setContext(null);
    };
  }, [surface, reveal]);
}

/**
 * The preview is a native view composited above the whole window, so no
 * z-index lifts a dialog or menu over it. Every floating layer mounts a
 * CoversPreview for as long as it is on screen, and while any is up the
 * preview stands a still of its page in for itself.
 */
const useCovers = create<{ count: number }>(() => ({ count: 0 }));

export const usePreviewCovered = (): boolean => useCovers((s) => s.count > 0);

/** The same answer outside render, for work that outlives the render that started it. */
export const isPreviewCovered = (): boolean => useCovers.getState().count > 0;

/**
 * Mount inside a floating layer's portal. Base UI keeps a portal mounted
 * through its exit animation, so the preview stays behind a closing layer
 * until it is gone. Tooltips go without: swapping the page out on every
 * hover costs more than the rare label that grazes the preview.
 */
export function CoversPreview(): null {
  useEffect(() => {
    useCovers.setState((s) => ({ count: s.count + 1 }));
    return () => useCovers.setState((s) => ({ count: s.count - 1 }));
  }, []);
  return null;
}
