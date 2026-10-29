import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "./motion";

/** A message to bring into view, such as a search result. Each new object asks again. */
export type Reveal = { messageId: string };

/**
 * Brings the message `reveal` names into view once it is on screen, a third of the way down, and marks it. Older
 * turns loading above it, work opening and blocks laying out as they near the view all move it, so it is held in
 * place, each frame and on every resize before it paints, until the conversation stops changing for a moment or the
 * reader takes over. A new `tailKey` returns the transcript to its tail, which ends the search. `onPlace` runs after
 * each placement, so the transcript keeps its own scroll bookkeeping in step.
 *
 * Call it after the transcript's own layout effects, so it places the message after they have followed the tail.
 */
export function useMessageReveal(
  parentRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  { reveal, blocks, tailKey, onPlace }: { reveal: Reveal | undefined; blocks: unknown; tailKey: unknown; onPlace: (el: HTMLElement) => void },
): void {
  const placed = useRef(onPlace);
  placed.current = onPlace;
  const [seeker] = useState(() => messageSeeker((el) => placed.current(el)));
  useEffect(() => {
    const el = parentRef.current;
    return el ? seeker.watch(el, contentRef.current) : undefined;
  }, [parentRef, contentRef, seeker]);
  useLayoutEffect(() => seeker.stop(), [tailKey, seeker]);
  useLayoutEffect(() => seeker.ask(parentRef.current, reveal?.messageId ?? null), [reveal, parentRef, seeker]);
  useLayoutEffect(() => seeker.seek(parentRef.current), [blocks, parentRef, seeker]);
}

function messageSeeker(onPlace: (el: HTMLElement) => void) {
  let seeking: string | null = null;
  let held: (() => void) | null = null;
  let frame = 0;
  const stop = () => {
    seeking = null;
    held = null;
    cancelAnimationFrame(frame);
  };

  const hold = (el: HTMLElement, id: string) => {
    const place = () => {
      const message = messageNode(el, id);
      if (message) placeInView(el, message);
      onPlace(el);
    };
    const started = performance.now();
    let height = -1;
    let quietSince = started;
    const tick = (now: number) => {
      place();
      if (el.scrollHeight !== height) {
        height = el.scrollHeight;
        quietSince = now;
      }
      if (now - quietSince < 400 && now - started < 3000) frame = requestAnimationFrame(tick);
      else held = null;
    };
    held = place;
    tick(started);
  };

  const seek = (el: HTMLElement | null) => {
    const id = seeking;
    const found = el && id ? messageNode(el, id) : undefined;
    if (!el || !id || !found || found.closest("[hidden]")) return;
    seeking = null;
    hold(el, id);
    markFound(found);
  };

  return {
    stop,
    seek,
    ask(el: HTMLElement | null, id: string | null) {
      stop();
      seeking = id;
      seek(el);
    },
    /** Lets the reader take over, and holds the message through resizes. Returns the function that stops watching. */
    watch(el: HTMLElement, content: HTMLElement | null) {
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY) stop();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stop();
      };
      el.addEventListener("wheel", onWheel, { passive: true });
      el.addEventListener("touchmove", stop, { passive: true });
      el.addEventListener("pointerdown", stop);
      el.addEventListener("keydown", onKeyDown);
      const observer = new ResizeObserver(() => held?.());
      observer.observe(el, { box: "border-box" });
      if (content) observer.observe(content, { box: "border-box" });
      return () => {
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("touchmove", stop);
        el.removeEventListener("pointerdown", stop);
        el.removeEventListener("keydown", onKeyDown);
        observer.disconnect();
        stop();
      };
    },
  };
}

const messageNode = (el: HTMLElement, id: string) => [...el.querySelectorAll<HTMLElement>("[data-message]")].find((node) => node.dataset["message"] === id);

/** Puts a message's top a third of the way down the view, with what led to it above. Its height may still grow as work opens. */
function placeInView(el: HTMLElement, message: HTMLElement) {
  const view = el.getBoundingClientRect();
  el.scrollTop += message.getBoundingClientRect().top - view.top - view.height / 3;
}

/** A wash under the message the view was brought to, so the eye lands on it. It holds, then fades; without motion it just ends. */
function markFound(message: HTMLElement) {
  const bubble = message.querySelector<HTMLElement>(".message-bubble");
  const target = bubble ?? message;
  const wash = bubble ? { backgroundColor: "var(--content-soft)" } : { backgroundColor: "var(--content-soft)", boxShadow: "0 0 0 8px var(--content-soft)", borderRadius: "var(--radius-lg)" };
  const clear = bubble ? { backgroundColor: "var(--bubble)" } : { backgroundColor: "transparent", boxShadow: "0 0 0 8px transparent", borderRadius: "var(--radius-lg)" };
  const keyframes = prefersReducedMotion() ? [wash, { ...wash, offset: 1 }] : [wash, { ...wash, offset: 0.55 }, clear];
  target.animate?.(keyframes, { duration: 1800, easing: "ease-out" });
}
