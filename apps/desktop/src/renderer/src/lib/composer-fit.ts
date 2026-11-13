import { useCallback } from "react";

/**
 * How much the composer's chips give up to fit their row, a step at a time: the model's effort, then the mode's and the
 * destination's names, then the model's name. Each keeps its mark, and its name stays in its label and hover title.
 */
export const COMPOSER_FIT = ["whole", "no-effort", "marks", "logos"] as const;
export type ComposerFit = (typeof COMPOSER_FIT)[number];

/**
 * Keeps the composer's bar at the first step where its chips fit without clipping, measured again whenever the bar
 * changes size or a chip's words change. Attach the returned ref to the bar; the step is its `data-fit`.
 */
export function useComposerFit() {
  return useCallback((bar: HTMLElement | null) => {
    if (!bar) return;
    const tools = bar.querySelector<HTMLElement>(".composer-tools");
    if (!tools) return;
    const fit = () => {
      for (const step of COMPOSER_FIT) {
        bar.dataset.fit = step;
        if (tools.scrollWidth <= tools.clientWidth) return;
      }
    };
    fit();
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resized?.observe(bar);
    const words = new MutationObserver(fit);
    words.observe(tools, { childList: true, subtree: true, characterData: true });
    return () => {
      resized?.disconnect();
      words.disconnect();
    };
  }, []);
}
