import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { useEffect, useState } from "react";
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

/**
 * The window's tooltip for anything that carries `data-tip`. Any element says what its tip is with that one attribute,
 * where the browser's own `title` would wait a second or more and draw outside the app's look; this layer opens the
 * app's tooltip over it after a short wait, and at once after a neighbour's. `Tooltip` stays for a
 * control whose tip is more than a line of text. Mounted once, beside the app in main.tsx.
 */
export function TipLayer() {
  const [tip, setTip] = useState<{ anchor: Element; label: string; shown: number } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let hovered: Element | null = null;
    let showing = false;
    let closedAt = -Infinity;
    let wait = 0;
    let gone = 0;
    let shown = 0;
    const read = (anchor: Element) => anchor.getAttribute("data-tip") ?? "";
    /** Closes the tip but stays on its element, so a press does not open it again until the pointer leaves. */
    const dismiss = () => {
      window.clearTimeout(wait);
      window.clearInterval(gone);
      if (showing) closedAt = performance.now();
      showing = false;
      setOpen(false);
    };
    const changes = new MutationObserver(() => {
      if (!hovered || !showing) return;
      const label = read(hovered);
      if (label) setTip({ anchor: hovered, label, shown });
      else dismiss();
    });
    const leave = () => {
      dismiss();
      changes.disconnect();
      hovered = null;
    };
    const show = (anchor: Element) => {
      const label = read(anchor);
      if (!anchor.isConnected || !worthShowing(anchor, label)) return;
      showing = true;
      shown += 1;
      setTip({ anchor, label, shown });
      setOpen(true);
      // An element taken off the page under the pointer sends no event of its own.
      gone = window.setInterval(() => {
        if (!anchor.isConnected) leave();
      }, 250);
    };
    const over = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
      if (anchor === hovered) return;
      leave();
      if (!anchor) return;
      hovered = anchor;
      changes.observe(anchor, { attributes: true, attributeFilter: ["data-tip"] });
      wait = window.setTimeout(() => show(anchor), performance.now() - closedAt < GROUP_MS ? 0 : DELAY_MS);
    };
    const root = document.documentElement;
    document.addEventListener("mouseover", over, true);
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
    document.addEventListener("scroll", dismiss, true);
    root.addEventListener("mouseleave", leave);
    window.addEventListener("blur", leave);
    return () => {
      leave();
      document.removeEventListener("mouseover", over, true);
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      root.removeEventListener("mouseleave", leave);
      window.removeEventListener("blur", leave);
    };
  }, []);
  return (
    <BaseTooltip.Root open={open && tip !== null} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
      <BaseTooltip.Portal>
        {/* A new tip is a new layer, so it reads its own ground and place instead of the last one's. */}
        <BaseTooltip.Positioner key={tip?.shown} anchor={tip?.anchor ?? null} sideOffset={6}>
          <BaseTooltip.Popup ref={floatingGround} className="tooltip-popup tooltip-popup-tip">
            {tip?.label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
