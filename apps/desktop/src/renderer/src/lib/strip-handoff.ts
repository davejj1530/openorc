import { useLayoutEffect, useRef, type RefObject } from "react";

/** Each tab's width as last drawn, carried from one drawing of a tab strip to the next. Tab ids are never reused. */
const drawn = new Map<string, number>();

const PINNED = ["transition", "min-width", "max-width", "margin-inline-end", "opacity"] as const;

/** Sets a tab where it was at once: its own transitions would otherwise ease it there, from where the stylesheet put it. */
function pin(node: HTMLElement, width: number): void {
  node.style.transition = "none";
  node.style.minWidth = `${width}px`;
  node.style.maxWidth = `${width}px`;
  if (width > 0) return;
  node.style.marginInlineEnd = "0px";
  node.style.opacity = "0";
}

const release = (node: HTMLElement) => PINNED.forEach((property) => node.style.removeProperty(property));

/**
 * Hands a tab's width from one drawing of it to the next: a strip a screen change draws anew, or a stand-in folding away
 * where a closed tab was. Every tab's size is watched as it is drawn, so its last width is known even after it is
 * gone. Before a tab is first painted it takes that width, or nothing when it is new; two frames later, past the
 * screen's own setup, it lets go and its transition eases it to its own width, or to nothing while it folds away. Tabs
 * are the strip's `[data-tab]` elements, named by that value.
 */
export function useStripHandoff(strip: RefObject<HTMLElement | null>, isNew: (id: string) => boolean): void {
  const watch = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) drawn.set((entry.target as HTMLElement).dataset.tab ?? "", entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width);
          });
    watch.current = observer;
    return () => observer?.disconnect();
  }, []);
  useLayoutEffect(() => {
    const pinned: HTMLElement[] = [];
    for (const node of strip.current?.querySelectorAll<HTMLElement>("[data-tab]:not([data-placed])") ?? []) {
      node.dataset.placed = "";
      watch.current?.observe(node);
      const id = node.dataset.tab ?? "";
      const from = isNew(id) ? 0 : drawn.get(id);
      if (from === undefined) continue;
      pin(node, from);
      pinned.push(node);
    }
    if (pinned.length) requestAnimationFrame(() => requestAnimationFrame(() => pinned.forEach(release)));
  });
}
