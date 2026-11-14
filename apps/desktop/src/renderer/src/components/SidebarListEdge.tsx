import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { edgeWords, nearestPast, pastEdges, scrollToBring, type EdgeTarget, type ListEdges, type ThreadStatus } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { prefersReducedMotion } from "../lib/motion";
import { cn } from "../lib/cn";
import { ChevronDown } from "./icons";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";

/** Something in the list that calls the person, and the element that stands for it: its row, or a folded project's label. */
export type EdgeCall = { thread: ThreadSummary; subthreads: ThreadStatus | null; anchor: string };

/** The height of an edge's line, which covers that much of the list's view. */
const LINE = 28;

const NONE: ListEdges = { above: [], below: [] };

function measure(list: HTMLElement, calls: readonly EdgeCall[]): EdgeTarget[] {
  const box = list.getBoundingClientRect();
  return calls.flatMap((call) => {
    const at = list.querySelector(call.anchor)?.getBoundingClientRect();
    return at ? [{ id: call.thread.id, top: at.top - box.top + list.scrollTop, bottom: at.bottom - box.top + list.scrollTop }] : [];
  });
}

const same = (a: ListEdges, b: ListEdges) => a.above.join() === b.above.join() && a.below.join() === b.below.join();

/**
 * What calls the person past each edge of a scrolling list, measured as it scrolls, resizes and renders, and a press that
 * brings the nearest one past an edge whole into view.
 */
export function useListEdges(calls: readonly EdgeCall[]) {
  const list = useRef<HTMLElement | null>(null);
  const latest = useRef(calls);
  latest.current = calls;
  const [edges, setEdges] = useState<ListEdges>(NONE);
  const update = useCallback(() => {
    const element = list.current;
    if (!element) return;
    const next = pastEdges(measure(element, latest.current), { top: element.scrollTop, bottom: element.scrollTop + element.clientHeight }, LINE);
    setEdges((old) => (same(old, next) ? old : next));
  }, []);
  const ref = useCallback(
    (element: HTMLElement | null) => {
      list.current = element;
      if (!element) return;
      element.addEventListener("scroll", update, { passive: true });
      const resized = new ResizeObserver(update);
      resized.observe(element);
      return () => {
        element.removeEventListener("scroll", update);
        resized.disconnect();
      };
    },
    [update],
  );
  useLayoutEffect(update);
  const bring = (edge: keyof ListEdges) => {
    const element = list.current;
    const id = nearestPast(edges, edge);
    const target = element && measure(element, latest.current).find((each) => each.id === id);
    if (!element || !target) return;
    element.scrollTo({ top: scrollToBring(target, { top: element.scrollTop, height: element.clientHeight }, LINE), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };
  return { ref, edges, bring };
}

/** The lines at the list's edges: what calls the person past each, its mark and title when one, how many when several. */
export function ListEdgeLines({ edges, calls, onBring }: { edges: ListEdges; calls: readonly EdgeCall[]; onBring: (edge: keyof ListEdges) => void }) {
  const byId = new Map(calls.map((call) => [call.thread.id, call]));
  return (["above", "below"] as const).map((edge) => {
    const past = edges[edge];
    if (!past.length) return null;
    const one = past.length === 1 ? byId.get(past[0]!) : undefined;
    const words = edgeWords(past, (id) => byId.get(id)?.thread.title ?? "");
    return (
      <button key={edge} type="button" className="sidebar-edge-line no-drag" data-edge={edge} onClick={() => onBring(edge)}>
        <ChevronDown size={14} className={cn("sidebar-edge-chevron", edge === "above" && "rotate-180")} />
        <span className="sidebar-edge-words" data-tip={one ? one.thread.title : undefined}>
          {words}
        </span>
        {one ? <ThreadStatusIndicator thread={one.thread} subthreads={one.subthreads} className="sidebar-edge-mark" /> : null}
      </button>
    );
  });
}
