import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

type Box = { left: number; top: number; width: number; height: number };

function sameBox(a: Box | null, b: Box | null): boolean {
  return a === b || (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
}

/**
 * Places a knob under the item in `track` that matches `selector`. The knob is an absolute
 * child of the track, measured in the track's content box, so it rides along when the track
 * scrolls sideways. It re-measures whenever the track or an item changes size (a font loads, a
 * count grows). `placed` turns true one frame after the first measurement: until then the knob
 * should not transition, so it appears in place instead of sliding in from the corner.
 */
export function useSlidingKnob(track: RefObject<HTMLElement | null>, selector: string, selection: unknown): { style: CSSProperties | undefined; placed: boolean } {
  const [box, setBox] = useState<Box | null>(null);
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () => {
      const target = element.querySelector<HTMLElement>(selector);
      const next = target ? { left: target.offsetLeft, top: target.offsetTop, width: target.offsetWidth, height: target.offsetHeight } : null;
      setBox((current) => (sameBox(current, next) ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [track, selector, selection]);

  useLayoutEffect(() => {
    if (placed || !box) return;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [box, placed]);

  if (!box) return { style: undefined, placed };
  return {
    style: { width: box.width, height: box.height, transform: `translate(${box.left}px, ${box.top}px)` },
    placed,
  };
}
