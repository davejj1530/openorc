import type { PreviewFocus } from "@openorc/protocol";

/*
 * Page code for a phone's input: each function runs in the page, sent as its source, so it reaches nothing outside its
 * own body but the helpers it is handed. Elements of a frame belong to the frame's window, so they are told apart by
 * their tag, never with `instanceof`.
 */

/** A point on the viewport, or in a frame's own document. */
interface Point {
  x: number;
  y: number;
}
type Hit = { element: Element | null } & Point;

/** The source that runs `fn` in the page with `arg`, handing it `helpers` after. */
export const pageCall = (fn: (arg: never, ...helpers: never[]) => unknown, arg: unknown, ...helpers: ((...args: never[]) => unknown)[]) =>
  `(${fn.toString()})(${[JSON.stringify(arg), ...helpers.map((helper) => helper.toString())].join(", ")})`;

/**
 * Run in every document of a pane a phone drives, before the page's own scripts and again on each input: alert,
 * confirm, prompt and print answer at once, with no dialog, until `until` and at any time while the page is not shown
 * on the Mac. Electron shows alert and confirm as a native box that, for a pane off its window, runs app-modal and holds
 * main until someone at the Mac clicks. Shown on the Mac, the box is a sheet on its window, which holds nothing, so after
 * the phone's last input the dialogs are the page's again. The dialogs are wrapped once per document.
 */
export function pageDialogs(until: number): void {
  const page = window as unknown as Record<symbol, number | undefined> & Record<string, unknown>;
  const drives = Symbol.for("openorc.phone.drives");
  page[drives] = Math.max(page[drives] ?? 0, until);
  const wrapped = Symbol.for("openorc.phone.dialogs");
  if (page[wrapped]) return;
  page[wrapped] = 1;
  const held = () => document.visibilityState === "hidden" || Date.now() < (page[drives] ?? 0);
  const answers: Record<string, unknown> = { alert: undefined, confirm: false, prompt: null, print: undefined };
  for (const name of Object.keys(answers)) {
    const own = page[name];
    if (typeof own !== "function") continue;
    const value = function (this: unknown, ...args: unknown[]) {
      return held() ? answers[name] : (own as (...args: unknown[]) => unknown).apply(this, args);
    };
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  }
}

/** What lies under a viewport point: through open shadow roots and same-origin frames, with the point in its frame. */
export function deepHit({ x, y }: Point): Hit {
  let at: Hit = { element: document.elementFromPoint(x, y), x, y };
  while (at.element) {
    const { element } = at;
    const inner = element.shadowRoot?.elementFromPoint(at.x, at.y);
    if (inner && inner !== element) {
      at = { ...at, element: inner };
      continue;
    }
    // Null for a frame of another site: Chromium routes the click into it.
    const inside = element.localName === "iframe" || element.localName === "frame" ? (element as HTMLIFrameElement).contentDocument : null;
    if (!inside) break;
    const box = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    const point = { x: at.x - box.left - element.clientLeft - (parseFloat(style.paddingLeft) || 0), y: at.y - box.top - element.clientTop - (parseFloat(style.paddingTop) || 0) };
    const next = inside.elementFromPoint(point.x, point.y);
    if (!next) break;
    at = { element: next, ...point };
  }
  return at;
}

/** Page code: what lies under the point, and for a select or a picker, its focus without a click. */
export function pageHit(point: Point, hitAt: typeof deepHit): "click" | "focused" {
  const hit = hitAt(point).element;
  // A select opens a native menu on macOS, and these inputs a native picker: they get focus instead of a click.
  const native = (): HTMLSelectElement | HTMLInputElement | null => {
    const select = hit?.closest("select");
    if (select) return !select.multiple && select.size <= 1 ? select : null;
    const picker = hit?.closest("input");
    return picker && ["color", "date", "datetime-local", "month", "week", "time"].includes(picker.type) ? picker : null;
  };
  const target = native();
  if (!target || target.disabled) return "click";
  target.focus();
  return "focused";
}

/**
 * Page code: scrolls the scroller under the point that can go that way, else its frame's page when it can, and so out
 * through the frames to the page, at once. A wheel event would be the page's own way, but a pane off screen takes one
 * only with its next frame, about once a second.
 */
export function pageScroll({ dx, dy, ...point }: Point & { dx: number; dy: number }, hitAt: typeof deepHit): void {
  const down = (element: Element) => (dy > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight : dy < 0 && element.scrollTop > 0);
  const across = (element: Element) => (dx > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth : dx < 0 && element.scrollLeft > 0);
  const can = (element: Element): boolean => {
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    const scrolls = (overflow: string) => ["auto", "scroll", "overlay"].includes(overflow);
    return (scrolls(style.overflowY) && down(element)) || (scrolls(style.overflowX) && across(element));
  };
  const by = { left: dx, top: dy, behavior: "instant" as ScrollBehavior };
  let element = hitAt(point).element;
  while (element) {
    const owner = element.ownerDocument;
    const page = owner.scrollingElement ?? owner.documentElement;
    for (; element && element !== page && element !== owner.body; element = element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null) {
      if (can(element)) return element.scrollBy(by);
    }
    // At the top, or in a frame of another site, the outer page takes what is left.
    const frame = owner.defaultView?.frameElement ?? null;
    if (!frame) break;
    if (down(page) || across(page)) return page.scrollBy(by);
    element = frame;
  }
  (document.scrollingElement ?? document.documentElement).scrollBy(by);
}

/** Page code: the focused element, through open shadow roots and same-origin frames, as a phone types or chooses there. */
export function pageFocus(choose: number | null): PreviewFocus | null {
  const is = <K extends keyof HTMLElementTagNameMap>(element: Element, tag: K): element is HTMLElementTagNameMap[K] => element.localName === tag;
  /** A select's options, after choosing the one asked for when it can be chosen. */
  const choice = (select: HTMLSelectElement): PreviewFocus => {
    const option = choose === null ? null : select.options[choose];
    if (option && !option.disabled && !select.disabled) {
      select.selectedIndex = choose!;
      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const options = Array.from(select.options)
      .slice(0, 500)
      .map((each) => ({ label: (each.label || each.text).trim().slice(0, 200), disabled: each.disabled }));
    return { kind: "choice", options, selected: select.selectedIndex };
  };
  /** Whether the element takes typing: a text-like field that is not read-only, or editable content. */
  const editable = (element: Element): boolean => {
    const typed = ["text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "week", "time"];
    if (is(element, "input")) return typed.includes(element.type) && !element.readOnly && !element.disabled;
    if (is(element, "textarea")) return !element.readOnly && !element.disabled;
    // isContentEditable, or the attribute where a DOM without layout does not compute it.
    return (element as HTMLElement).isContentEditable === true || element.closest('[contenteditable]:not([contenteditable="false"])') !== null;
  };
  /** The keys and the return key the element asks for, by its inputmode and enterkeyhint, else by its type. */
  const keys = (element: Element) => {
    const type = is(element, "input") ? element.type : "text";
    const byType: Record<string, string> = {
      email: "email",
      url: "url",
      tel: "tel",
      search: "search",
      number: "decimal",
      date: "numeric",
      "datetime-local": "numeric",
      month: "numeric",
      week: "numeric",
      time: "numeric",
    };
    const mode = element.getAttribute("inputmode") ?? "";
    const hint = element.getAttribute("enterkeyhint") ?? "";
    const keyboard = ["email", "url", "numeric", "decimal", "tel", "search"].includes(mode) ? mode : (byType[type] ?? "default");
    let enter = ["go", "next", "search", "send", "done"].includes(hint) ? hint : "default";
    if (enter === "default" && type === "search") enter = "search";
    return { keyboard, enter, secure: type === "password" };
  };
  /** The focus inside an element: in its open shadow root, or in the document of its frame when it is of this site. */
  const within = (element: Element) => element.shadowRoot?.activeElement ?? (["iframe", "frame"].includes(element.localName) ? (element as HTMLIFrameElement).contentDocument?.activeElement : null);
  let element = document.activeElement;
  for (let inner = element && within(element); inner; inner = within(inner)) element = inner;
  if (element && is(element, "select")) return choice(element);
  if (!element || !editable(element)) return null;
  return { kind: "text", ...keys(element), multiline: !is(element, "input") } as PreviewFocus;
}
