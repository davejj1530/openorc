import { useCallback, useRef, useState } from "react";

type Edges = { start: boolean; end: boolean };

const NONE: Edges = { start: false, end: false };

/**
 * Which ends of a scrolling list have more past them, for `.scroll-edges` (or `.scroll-edges-x` across) to fade there.
 * Spread the result on the list: it measures when the list attaches, scrolls or changes size, and as its rows come and go.
 */
export function useScrollEdges(axis: "x" | "y" = "y") {
  const [edges, setEdges] = useState<Edges>(NONE);
  const list = useRef<HTMLElement | null>(null);
  const measure = useCallback(() => {
    const element = list.current;
    if (!element) return;
    const [scrolled, shown, whole] = axis === "x" ? [element.scrollLeft, element.clientWidth, element.scrollWidth] : [element.scrollTop, element.clientHeight, element.scrollHeight];
    const next = { start: scrolled > 0, end: scrolled + shown < whole - 1 };
    setEdges((old) => (old.start === next.start && old.end === next.end ? old : next));
  }, [axis]);
  const ref = useCallback(
    (element: HTMLElement | null) => {
      list.current = element;
      if (!element) return;
      measure();
      const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
      resized?.observe(element);
      const rows = new MutationObserver(measure);
      rows.observe(element, { childList: true });
      return () => {
        resized?.disconnect();
        rows.disconnect();
        list.current = null;
      };
    },
    [measure],
  );
  return { ref, onScroll: measure, "data-more-start": edges.start || undefined, "data-more-end": edges.end || undefined };
}
