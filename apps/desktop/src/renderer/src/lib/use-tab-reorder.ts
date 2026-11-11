import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./motion";

/** Puts a tab ahead of another in its strip, or last when there is none to put it ahead of. */
export type ReorderTab = (id: string, beforeId: string | null) => void;

/** How far the pointer travels before a press on a tab becomes a drag, so a click stays a click. */
const SLOP = 4;
/** A tab held this close to an end of a strip that has outgrown its bar scrolls it, this far each frame. */
const EDGE = 32;
const SCROLL_STEP = 8;
/** The dropped tab's glide into its place: --duration-arrive on --ease-out. */
const settle = { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

/** A tab as it stood when the drag began, measured along the strip's own scrolling length. */
interface Slot {
  id: string;
  node: HTMLElement;
  left: number;
  right: number;
}

const middle = (slot: Slot) => (slot.left + slot.right) / 2;

/** Where a tab held between `left` and `right` lands: past each neighbour whose middle its leading edge has crossed. */
function landing(slots: readonly Slot[], from: number, left: number, right: number): number {
  const ahead = slots.findIndex((slot, index) => index < from && left < middle(slot));
  if (ahead >= 0) return ahead;
  const behind = slots.findLastIndex((slot, index) => index > from && right > middle(slot));
  return behind >= 0 ? behind : from;
}

/**
 * Carries one tab along its strip under the pointer while the tabs it passes step aside, then hands back how to drop
 * it. Nothing is reordered until the drop: the tabs only shift where they are drawn.
 */
function carry(strip: HTMLElement, tab: HTMLElement, grabbedAt: number) {
  const along = (clientX: number) => clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
  const slots = [...strip.querySelectorAll<HTMLElement>("[data-tab]:not([data-leaving])")].map((node): Slot => {
    const box = node.getBoundingClientRect();
    return { id: node.dataset.tab ?? "", node, left: along(box.left), right: along(box.right) };
  });
  const from = slots.findIndex((slot) => slot.node === tab);
  const held = slots[from]!;
  const width = held.right - held.left;
  const step = width + (slots[1]!.left - slots[0]!.right);
  const grip = along(grabbedAt) - held.left;
  let to = from;
  /** How far a tab the held one has passed stands from its own place: one step toward where the held tab came from. */
  const aside = (index: number) => {
    if (index > from && index <= to) return -step;
    if (index < from && index >= to) return step;
    return 0;
  };
  // A tab picked up again while it still glides from its last drop follows the pointer at once.
  for (const glide of tab.getAnimations()) glide.cancel();
  strip.dataset.reordering = "";
  tab.dataset.dragged = "";
  return {
    follow(clientX: number) {
      const left = Math.min(Math.max(along(clientX) - grip, slots[0]!.left), slots.at(-1)!.right - width);
      to = landing(slots, from, left, left + width);
      slots.forEach((slot, index) => {
        slot.node.style.transform = `translateX(${index === from ? left - held.left : aside(index)}px)`;
      });
    },
    /**
     * Lets every tab go, reorders when the tab was dropped somewhere new, and glides it from the pointer into its
     * place. It keeps its dragged look until it is there, since it still passes over its neighbours.
     */
    drop(reorder: ReorderTab | null) {
      const droppedAt = tab.getBoundingClientRect().left;
      if (reorder && to !== from) {
        const order = slots.map((slot) => slot.id);
        order.splice(to, 0, ...order.splice(from, 1));
        flushSync(() => reorder(held.id, order[to + 1] ?? null));
      }
      delete strip.dataset.reordering;
      for (const slot of slots) slot.node.style.removeProperty("transform");
      const offset = droppedAt - tab.getBoundingClientRect().left;
      const landed = () => delete tab.dataset.dragged;
      if (!offset || prefersReducedMotion()) return void landed();
      tab.animate([{ transform: `translateX(${offset}px)` }, { transform: "none" }], settle).onfinish = landed;
    },
  };
}

/** Follows one press on a tab until it ends, as a click or as a drag that reorders. Returns how to abandon it. */
function press(strip: HTMLElement, tab: HTMLElement, down: PointerEvent, reorder: ReorderTab): () => void {
  let carried: ReturnType<typeof carry> | null = null;
  let pointerX = down.clientX;
  let frame = 0;
  const scrollAtEdges = () => {
    const box = strip.getBoundingClientRect();
    const before = strip.scrollLeft;
    if (pointerX < box.left + EDGE) strip.scrollLeft -= SCROLL_STEP;
    else if (pointerX > box.right - EDGE) strip.scrollLeft += SCROLL_STEP;
    if (strip.scrollLeft !== before) carried?.follow(pointerX);
    frame = requestAnimationFrame(scrollAtEdges);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== down.pointerId) return;
    pointerX = event.clientX;
    if (!carried) {
      if (Math.abs(pointerX - down.clientX) < SLOP) return;
      carried = carry(strip, tab, down.clientX);
      frame = requestAnimationFrame(scrollAtEdges);
    }
    carried.follow(pointerX);
  };
  // A tab's mark may be an image, which the browser would lift into a drag of its own, cancelling this one.
  const keep = (event: DragEvent) => event.preventDefault();
  const end = (commit: boolean) => {
    strip.removeEventListener("dragstart", keep);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    cancelAnimationFrame(frame);
    if (!carried) return;
    carried.drop(commit ? reorder : null);
    carried = null;
    // The release still clicks the tab under the pointer; a drag is not a click on it.
    const swallow = (event: MouseEvent) => event.stopPropagation();
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true));
  };
  const up = (event: PointerEvent) => event.pointerId === down.pointerId && end(true);
  const cancel = (event: PointerEvent) => event.pointerId === down.pointerId && end(false);
  strip.addEventListener("dragstart", keep);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  return () => end(false);
}

/**
 * Lets a tab strip's tabs be dragged into a new order. The strip's tabs are its `[data-tab]` elements, named by that
 * value. Returns the strip's pointer-down handler: a press on a tab that travels becomes a drag, the tab follows the
 * pointer while the others make room, and the drop calls `reorder`. A strip of one tab has nothing to reorder, and a
 * press on a tab's close or on a name being edited is left alone.
 */
export function useTabReorder(strip: RefObject<HTMLElement | null>, reorder: ReorderTab): (event: ReactPointerEvent<HTMLElement>) => void {
  const abandon = useRef<(() => void) | null>(null);
  useEffect(() => () => abandon.current?.(), []);
  return (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>("[data-tab]:not([data-leaving])");
    if (event.button !== 0 || !tab || !strip.current || target.closest("input, .work-tab-close")) return;
    if (strip.current.querySelectorAll("[data-tab]:not([data-leaving])").length < 2) return;
    abandon.current?.();
    abandon.current = press(strip.current, tab, event.nativeEvent, reorder);
  };
}
