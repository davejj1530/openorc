import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { floatingGround } from "../lib/use-anchor-ground";

/**
 * The wait before the first tip. Longer than a Tooltip's 400ms: a Tooltip names a control you are about to press, while
 * these mostly sit on text the pointer only passes over, where a quick tip gets in the way. Still well under the
 * second or two the browser's own takes.
 */
const DELAY_MS = 800;
/** After one tip closes, the next opens at once for this long, the way Base UI groups its tooltips. */
const GROUP_MS = 400;

const words = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether any of the element's own text is cut off by its box. */
function clipped(element: Element): boolean {
  return [element, ...element.querySelectorAll("*")].some((each) => {
    if (each.scrollWidth <= each.clientWidth + 1 && each.scrollHeight <= each.clientHeight + 1) return false;
    return getComputedStyle(each).overflow !== "visible";
  });
}

/** A tip that only repeats what the element already shows is worth opening when that text is cut off, and not otherwise. */
function worthShowing(anchor: Element, label: string): boolean {
  if (!label) return false;
  return words(anchor.textContent ?? "") !== words(label) || clipped(anchor);
}

type Tip = { anchor: Element; label: string; shown: number; detail: boolean };

function readTip(anchor: Element): string {
  const title = anchor.getAttribute("data-tip") ?? "";
  const detail = anchor.getAttribute("data-tip-detail");
  if (!detail) return title;
  return clipped(anchor.querySelector("[data-tip-title]") ?? anchor) ? `${title}\n${detail}` : detail;
}

function tipAnchor(target: EventTarget | null): Element | null {
  return target instanceof Element ? (target.closest("[data-tip-detail]") ?? target.closest("[data-tip]")) : null;
}

function observeTips(onTip: (tip: Tip) => void, onClose: () => void) {
  let hovered: Element | null = null;
  let showing = false;
  let closedAt = -Infinity;
  let wait = 0;
  let gone = 0;
  let shown = 0;
  const dismiss = () => {
    window.clearTimeout(wait);
    window.clearInterval(gone);
    if (showing) closedAt = performance.now();
    showing = false;
    onClose();
  };
  const update = (anchor: Element, label: string) => onTip({ anchor, label, shown, detail: anchor.hasAttribute("data-tip-detail") });
  const changes = new MutationObserver(() => {
    if (!hovered || !showing) return;
    const label = readTip(hovered);
    if (label) update(hovered, label);
    else dismiss();
  });
  const leave = () => {
    dismiss();
    changes.disconnect();
    hovered = null;
  };
  const show = (anchor: Element) => {
    const label = readTip(anchor);
    if (!anchor.isConnected || !worthShowing(anchor, label)) return;
    showing = true;
    shown += 1;
    update(anchor, label);
    // Removing an anchor under the pointer sends no leave event.
    gone = window.setInterval(() => {
      if (!anchor.isConnected) leave();
    }, 250);
  };
  const enter = (anchor: Element | null, focused = false) => {
    if (anchor === hovered) return;
    leave();
    if (!anchor) return;
    hovered = anchor;
    changes.observe(anchor, { attributes: true, attributeFilter: ["data-tip", "data-tip-detail"] });
    wait = window.setTimeout(() => show(anchor), focused || performance.now() - closedAt < GROUP_MS ? 0 : DELAY_MS);
  };
  const over = (event: MouseEvent) => enter(tipAnchor(event.target));
  const focus = (event: FocusEvent) => {
    const anchor = tipAnchor(event.target);
    if (anchor?.hasAttribute("data-tip-detail") && anchor.matches(":focus-visible")) enter(anchor, true);
  };
  const root = document.documentElement;
  document.addEventListener("mouseover", over, true);
  document.addEventListener("focusin", focus, true);
  document.addEventListener("focusout", leave, true);
  document.addEventListener("mousedown", dismiss, true);
  document.addEventListener("keydown", dismiss, true);
  document.addEventListener("scroll", dismiss, true);
  root.addEventListener("mouseleave", leave);
  window.addEventListener("blur", leave);
  return () => {
    leave();
    document.removeEventListener("mouseover", over, true);
    document.removeEventListener("focusin", focus, true);
    document.removeEventListener("focusout", leave, true);
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", dismiss, true);
    document.removeEventListener("scroll", dismiss, true);
    root.removeEventListener("mouseleave", leave);
    window.removeEventListener("blur", leave);
  };
}

/** The window's shared data-tip layer. Row details also open on keyboard focus and wrap only at the viewport edge. */
export function TipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      observeTips(
        (next) => {
          setTip(next);
          setOpen(true);
        },
        () => setOpen(false),
      ),
    [],
  );
  return (
    <BaseTooltip.Root open={open && tip !== null} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner key={tip?.shown} anchor={tip?.anchor ?? null} sideOffset={6}>
          <BaseTooltip.Popup ref={floatingGround} className={cn("tooltip-popup tooltip-popup-tip", tip?.detail && "tooltip-popup-detail")}>
            {tip?.label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
