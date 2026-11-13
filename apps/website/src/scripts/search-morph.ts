/*
 * Shared animated properties keep the search field, results panel and clipping bounds aligned.
 * Each transition starts from the current shape, so toggling mid-animation reverses it smoothly.
 */

export interface MorphParts {
  pill: HTMLElement;
  scrim: HTMLElement;
  /** Holds the field and the panel, and carries the shape they are laid out from. */
  column: HTMLElement;
  /** Where the open field rests. */
  slot: HTMLElement;
  fieldFill: HTMLElement;
  panel: HTMLElement;
  /** The panel's scrolling contents, laid out at their open size. */
  content: HTMLElement;
  /** The results, whose [data-part] labels and rows arrive one after another. */
  results: HTMLElement;
}

/** The field's box, its inset, and the panel's top and height: the properties search.css registers. */
type Shape = Record<"--search-x" | "--search-y" | "--search-width" | "--search-height" | "--search-inset" | "--search-panel-y" | "--search-panel-height", string>;

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const ms = (duration: number) => (still() ? 1 : duration);

/** A critically damped spring at 2π / 0.36s, sampled over 500ms. */
const springMs = 500;
const springEase = (() => {
  const omega = (2 * Math.PI) / 0.36;
  const steps = 40;
  const points = Array.from({ length: steps + 1 }, (_, i) => {
    const t = (i / steps) * (springMs / 1000);
    return i === steps ? 1 : 1 - (1 + omega * t) * Math.exp(-omega * t);
  });
  return `linear(${points.map((point) => point.toFixed(4)).join(", ")})`;
})();
const glide = "cubic-bezier(0.22, 1, 0.36, 1)";

const spring = (): KeyframeAnimationOptions => ({ duration: ms(springMs), easing: springEase });
/** How the scrim and the fills fade. */
const fade = (): KeyframeAnimationOptions => ({ duration: ms(200), easing: glide });
/** How the panel's parts arrive once it has begun to grow, and how fast they blur away. */
const arrive = (index: number): KeyframeAnimationOptions => ({ duration: ms(200), delay: ms(40 + Math.min(index, 7) * 40), easing: glide, fill: "backwards" });
const leave = (): KeyframeAnimationOptions => ({ duration: ms(120), easing: glide, fill: "forwards" });

/** The gap between the field and the panel, as search.css draws it. */
const gap = 10;

/** Where an element is now, in the properties a move is about to change. */
function now(element: Element, keys: readonly string[]): Keyframe {
  const style = getComputedStyle(element);
  return Object.fromEntries(keys.map((key) => [key, style.getPropertyValue(key.startsWith("--") ? key : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))]));
}

/** Moves an element to `to` from `start` when nothing is moving it, or else from wherever the running move has it. */
function move(element: Element, to: Keyframe, options: KeyframeAnimationOptions, start?: Keyframe) {
  const running = element.getAnimations();
  const from = start && running.length === 0 ? start : now(element, Object.keys(to));
  for (const animation of running) animation.cancel();
  return element.animate([from, to], options);
}

export function createMorph({ pill, scrim, column, slot, fieldFill, panel, content, results }: MorphParts) {
  /** The field's inset at rest, read while nothing moves it. */
  const restInset = getComputedStyle(column).getPropertyValue("--search-inset");
  /** The panel's height the last time it was sent to rest, so a change of contents at rest can grow from it. */
  let settled = 0;

  function pillShape(): Shape {
    const from = pill.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    return {
      "--search-x": `${from.left - to.left}px`,
      "--search-y": `${from.top - to.top}px`,
      "--search-width": `${from.width}px`,
      "--search-height": `${from.height}px`,
      "--search-inset": getComputedStyle(pill).paddingLeft,
      "--search-panel-y": `${-(gap + slot.offsetHeight / 2)}px`,
      "--search-panel-height": "0px",
    };
  }

  const restShape = (panelHeight = "100%"): Shape => ({
    "--search-x": "0px",
    "--search-y": "0px",
    "--search-width": "100%",
    "--search-height": "100%",
    "--search-inset": restInset,
    "--search-panel-y": "0px",
    "--search-panel-height": panelHeight,
  });

  /** Sends the field and the panel to their open shape, from `start` when they are at rest. */
  function toRest(start: Shape) {
    settled = content.offsetHeight;
    move(column, restShape(), spring(), start);
  }

  function open() {
    toRest(pillShape());
    for (const layer of [scrim, fieldFill, panel]) move(layer, { opacity: "1" }, fade(), { opacity: "0" });
    results
      .querySelectorAll("[data-part]")
      .forEach((part, i) => move(part, { opacity: "1", filter: "blur(0px)", transform: "none" }, arrive(i), { opacity: "0", filter: "blur(4px)", transform: "translateY(-6px)" }));
  }

  /** Runs everything back into the pill. Resolves true once it is there, false when a newer open overtook it. */
  function close(): Promise<boolean> {
    const back = move(column, pillShape(), { ...spring(), fill: "forwards" });
    for (const layer of [scrim, fieldFill]) move(layer, { opacity: "0" }, { ...fade(), fill: "forwards" });
    move(panel, { opacity: "0" }, leave());
    for (const part of results.querySelectorAll("[data-part]")) move(part, { opacity: "0", filter: "blur(4px)" }, leave());
    return back.finished.then(
      () => true,
      () => false,
    );
  }

  /** The contents changed size while open: the panel follows on the spring instead of jumping. */
  function follow() {
    if (content.offsetHeight !== settled) toRest(restShape(`${settled}px`));
  }

  return { open, close, follow };
}
