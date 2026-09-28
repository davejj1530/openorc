import { moment, type Timeline } from "../data/hero";

/**
 * Spring motion for scenes that opt in with `data-motion`. Like the rest of the
 * player it is a pure function of scene time: each value is a sum of closed-form
 * spring responses, one per window edge, so seeking, looping and reduced motion
 * need no state.
 *
 * - `[data-grow]` blocks open their space before their content fades in, and
 *   close it again when their window ends, so nothing below them jumps.
 * - `.hs-flight` chips carry a message from one thread (`data-from`) to the
 *   notice it becomes in another (`data-to`), between `data-start` and `data-land`.
 *
 * Only elements near a window edge are written each frame.
 */

interface Spring {
  f: number;
  z: number;
}
const OPEN: Spring = { f: 1.7, z: 0.9 };
const FADE: Spring = { f: 2.6, z: 0.86 };
const FLIGHT: Spring = { f: 1.5, z: 0.95 };
/** Seconds after an edge before every spring here has settled. */
const SETTLE = 1.2;
/** Content starts to appear this long after its block starts to open. */
const FADE_DELAY = 0.15;
/** A message spends its last stretch of flight opening into the notice. */
const LANDING = 0.3;

/** Step response of a damped spring from 0 to 1, `dt` seconds after it starts. */
function spring(dt: number, { f, z }: Spring): number {
  if (dt <= 0) return 0;
  if (!Number.isFinite(dt)) return 1;
  const w = 2 * Math.PI * f;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * dt) * (Math.cos(wd * dt) + ((z * w) / wd) * Math.sin(wd * dt));
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

type Interval = [from: number, to: number];

/** `a~b`, `>a` and `<a` windows as numeric intervals. */
function intervals(windows: string, timeline: Timeline): Interval[] {
  return windows.split(" ").map((window) => {
    if (window.startsWith(">")) return [moment(window.slice(1), timeline), Infinity];
    if (window.startsWith("<")) return [-Infinity, moment(window.slice(1), timeline)];
    const [from, to] = window.split("~");
    return [moment(from, timeline), moment(to, timeline)];
  });
}

/** How present an element is: 0 outside its windows, 1 inside, springing between. */
function presence(t: number, spans: Interval[], cfg: Spring, delay = 0): number {
  return clamp(spans.reduce((sum, [from, to]) => sum + spring(t - from - delay, cfg) - spring(t - to - delay, cfg), 0));
}

const settling = (t: number, spans: Interval[]) => spans.some(([from, to]) => (t >= from && t < from + SETTLE) || (t >= to && t < to + SETTLE));

interface Grow {
  el: HTMLElement;
  spans: Interval[];
  /** Natural margins and paddings, which close along with the height. */
  box: { mt: number; mb: number; pt: number; pb: number };
  still: boolean;
}

interface Flight {
  el: HTMLElement;
  label: HTMLElement;
  from: HTMLElement;
  to: HTMLElement;
  start: number;
  land: number;
}

/** Windows and resting boxes of every [data-grow] block for a timeline. */
function readGrows(root: HTMLElement, timeline: Timeline): Grow[] {
  return [...root.querySelectorAll<HTMLElement>("[data-grow]")].map((el) => {
    const style = getComputedStyle(el);
    const px = (value: string) => parseFloat(value) || 0;
    return {
      el,
      spans: intervals(el.dataset.grow || el.dataset.show!, timeline),
      box: { mt: px(style.marginTop), mb: px(style.marginBottom), pt: px(style.paddingTop), pb: px(style.paddingBottom) },
      still: false,
    };
  });
}

function readFlights(root: HTMLElement, timeline: Timeline): Flight[] {
  const anchor = (name: string | undefined) => root.querySelector<HTMLElement>(`[data-anchor="${name}"]`)!;
  return [...root.querySelectorAll<HTMLElement>(".hs-flight")].map((el) => ({
    el,
    label: el.querySelector<HTMLElement>(".hs-flight-label")!,
    from: anchor(el.dataset.from),
    to: anchor(el.dataset.to),
    // The chip leaves once its "Sending message" row has come in.
    start: moment(el.dataset.start!, timeline) + FADE_DELAY + 0.1,
    land: moment(el.dataset.land!, timeline),
  }));
}

const STYLED = ["height", "marginTop", "marginBottom", "paddingTop", "paddingBottom", "overflow", "opacity", "filter", "translate"] as const;

/** A block at rest: shown or hidden, with none of the motion's inline styles. */
function rest(item: Grow, shown: boolean) {
  item.el.hidden = !shown;
  for (const key of STYLED) item.el.style[key] = "";
  item.still = true;
}

/** The block's full height, read while its motion styles may be holding it smaller. */
function naturalHeight(el: HTMLElement) {
  el.hidden = false;
  const padding = (parseFloat(el.style.paddingTop) || 0) + (parseFloat(el.style.paddingBottom) || 0);
  return el.scrollHeight - padding + (el.offsetHeight - el.clientHeight);
}

/** One moving block: its space opens with `open`, its content arrives with `shown`. */
function place(item: Grow, t: number, natural: number) {
  const { el, box } = item;
  const open = presence(t, item.spans, OPEN);
  const shown = presence(t, item.spans, FADE, FADE_DELAY);
  item.still = false;
  el.hidden = open < 0.003 && shown < 0.003;
  const opening = open <= 0.997;
  el.style.overflow = opening ? "hidden" : "";
  el.style.height = opening ? `${(natural + box.pt + box.pb) * open}px` : "";
  el.style.marginTop = opening ? `${box.mt * open}px` : "";
  el.style.marginBottom = opening ? `${box.mb * open}px` : "";
  el.style.paddingTop = opening ? `${box.pt * open}px` : "";
  el.style.paddingBottom = opening ? `${box.pb * open}px` : "";
  el.style.opacity = shown > 0.997 ? "" : shown.toFixed(3);
  el.style.filter = shown > 0.99 ? "" : `blur(${((1 - shown) * 6).toFixed(2)}px)`;
  el.style.translate = shown > 0.99 ? "" : `0 ${((1 - shown) * 4).toFixed(2)}px`;
}

function renderGrows(grows: Grow[], t: number) {
  const moving = grows.filter((item) => settling(t, item.spans));
  for (const item of grows) {
    if (moving.includes(item)) continue;
    if (item.still) item.el.hidden = presence(t, item.spans, OPEN) < 0.5;
    else rest(item, presence(t, item.spans, OPEN) > 0.5);
  }
  // Reads first, then writes, so the frame lays out once.
  const naturals = moving.map((item) => naturalHeight(item.el));
  moving.forEach((item, i) => place(item, t, naturals[i]));
}

/** Where a notice sits, or will appear: before it opens, that is where its next visible sibling starts. */
function destination(to: HTMLElement) {
  if (to.offsetParent) return to.getBoundingClientRect();
  let next = to.nextElementSibling as HTMLElement | null;
  while (next && !next.offsetParent) next = next.nextElementSibling as HTMLElement | null;
  const column = to.parentElement!;
  const style = getComputedStyle(column);
  const box = column.getBoundingClientRect();
  const inset = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return { left: box.left + (parseFloat(style.paddingLeft) || 0), top: next ? next.getBoundingClientRect().top : box.bottom, width: column.clientWidth - inset };
}

/** A flight runs while both threads are on screen; one pane at a time has nothing to cross. */
const flying = (f: Flight, t: number) => t >= f.start && t < f.land + 0.05 && Boolean(f.from.offsetParent) && Boolean(f.to.closest<HTMLElement>(".hs-pane")?.offsetParent);

function renderFlights(root: HTMLElement, flights: Flight[], t: number) {
  const active = flights.filter((f) => flying(f, t));
  for (const f of flights) f.el.hidden = !active.includes(f);
  if (!active.length) return;
  const origin = root.getBoundingClientRect();
  const unit = origin.width / 1360;
  const rects = active.map((f) => ({ a: f.from.getBoundingClientRect(), b: destination(f.to), natural: f.to.scrollHeight + (f.to.offsetHeight - f.to.clientHeight) }));
  active.forEach((f, i) => {
    const { a, b, natural } = rects[i];
    const p = spring(t - f.start, FLIGHT);
    const v = clamp((t - (f.land - LANDING)) / LANDING);
    const q = v * v * (3 - 2 * v);
    f.el.dataset.width ??= String(f.label.scrollWidth + 52 * unit);
    const style = f.el.style;
    style.left = `${(lerp(a.left + 8 * unit, b.left, p) - origin.left).toFixed(2)}px`;
    style.top = `${(lerp(a.top - 4 * unit, b.top, p) - origin.top - 56 * unit * Math.sin(Math.PI * clamp(p))).toFixed(2)}px`;
    style.width = `${lerp(Number(f.el.dataset.width), b.width, q).toFixed(2)}px`;
    style.height = `${lerp(34 * unit, natural, q).toFixed(2)}px`;
    style.borderRadius = `${lerp(17, 14, q) * unit}px`;
    style.opacity = (1 - q).toFixed(3);
    f.label.style.opacity = (1 - clamp(q * 2)).toFixed(3);
  });
}

export function createMotion(root: HTMLElement) {
  let grows: Grow[] = [];
  let flights: Flight[] = [];
  return {
    /** Reads windows and resting boxes for the current timeline and width. */
    prepare(timeline: Timeline) {
      grows = readGrows(root, timeline);
      flights = readFlights(root, timeline);
      for (const f of flights) delete f.el.dataset.width;
    },
    /** Every frame while the scene plays. */
    render(t: number) {
      renderGrows(grows, t);
      renderFlights(root, flights, t);
    },
    /** The at-rest state at `t`, for reduced motion and first paint. */
    settle(t: number) {
      for (const item of grows) rest(item, presence(t, item.spans, OPEN) > 0.5);
      for (const f of flights) f.el.hidden = true;
    },
  };
}

/** Calls `changed` when the frame's width changes, since every measured size follows it. */
export function watchWidth(root: HTMLElement, changed: () => void) {
  let width = root.clientWidth;
  new ResizeObserver(() => {
    if (root.clientWidth === width) return;
    width = root.clientWidth;
    changed();
  }).observe(root);
}
