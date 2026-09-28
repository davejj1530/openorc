import { journeys, moment, visibleAt, type Journey, type Layout, type SceneId, type Timeline } from "../data/hero";
import { createMotion, watchWidth } from "./hero-motion";

/** How long the scene fades out and back in when the journey starts over, in seconds. */
const JOURNEY_FADE_SECONDS = 0.45;
const MAX_FRAME_ELAPSED_MS = 100;
const RENDER_INTERVAL_SECONDS = 1 / 30;

interface Typing {
  el: HTMLElement;
  /** Composer text after each keystroke, with the time it lands. */
  keys: { at: number; text: string }[];
  shown: string | null;
}
interface Stream {
  words: HTMLElement[];
  at: number[];
  shown: number;
}

/**
 * Plays a scene's journey against the markup its SceneFrame renders. The scene
 * state is a function of time, so pausing only stops the clock, reduced motion
 * shows the last moment, and the journey loops by fading back to its first moment.
 */
export function initHeroScene(root: HTMLElement) {
  const journey = journeys[root.dataset.scene as SceneId];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = window.matchMedia("(max-width: 1100px)");
  // A scene with data-motion opens and closes its [data-grow] blocks with springs instead of toggling them.
  const motion = root.hasAttribute("data-motion") ? createMotion(root) : null;
  const scene = bindScene(root, journey, motion ? ":not([data-grow])" : "");

  let layout: Layout = narrow.matches ? "narrow" : "wide";
  let timeline: Timeline = journey.timelines[layout];
  let elapsedSeconds = 0;
  let previousFrameMs: number | null = null;
  let lastRenderedSeconds = -1;
  let frameRequest = 0;
  let visible = false;
  let paused = reducedMotion.matches;

  const prepare = () => {
    timeline = journey.timelines[layout];
    motion?.prepare(timeline);
    scene.prepare(timeline);
  };
  const render = (sceneSeconds: number) => scene.render(sceneSeconds, timeline, layout);

  const tick = (now: number) => {
    frameRequest = 0;
    if (previousFrameMs !== null) elapsedSeconds += Math.min(now - previousFrameMs, MAX_FRAME_ELAPSED_MS) / 1000;
    previousFrameMs = now;
    const end = moment("end", timeline);
    if (elapsedSeconds >= end + JOURNEY_FADE_SECONDS) {
      elapsedSeconds = 0;
      lastRenderedSeconds = -1;
      root.removeAttribute("data-fading");
    } else if (elapsedSeconds >= end) root.setAttribute("data-fading", "");
    // The fixtures change in words and short state transitions. Thirty updates
    // per second keep typing fluid without walking every scene node each frame.
    const renderTime = Math.min(elapsedSeconds, end);
    if (renderTime - lastRenderedSeconds >= RENDER_INTERVAL_SECONDS || (renderTime === end && lastRenderedSeconds < end)) {
      render(renderTime);
      lastRenderedSeconds = renderTime;
    }
    // Springs need every frame; the motion layer writes only what is moving.
    motion?.render(renderTime);
    schedule();
  };

  const schedule = () => {
    const running = visible && !paused && !document.hidden;
    root.toggleAttribute("data-paused", !running);
    if (running && !frameRequest) frameRequest = requestAnimationFrame(tick);
    if (!running) {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      previousFrameMs = null;
    }
  };

  /** Starts the journey from its first moment, or shows its last one when motion is reduced. */
  const restart = () => {
    elapsedSeconds = reducedMotion.matches && paused ? moment("end", timeline) : 0;
    lastRenderedSeconds = elapsedSeconds;
    previousFrameMs = null;
    root.removeAttribute("data-fading");
    render(elapsedSeconds);
    motion?.[paused ? "settle" : "render"](elapsedSeconds);
    schedule();
  };

  prepare();
  root.setAttribute("data-engine", "");
  restart();

  // Sizes the motion layer measured follow the frame's width.
  if (motion)
    watchWidth(root, () => {
      motion.prepare(timeline);
      if (paused) motion.settle(lastRenderedSeconds);
    });

  narrow.addEventListener("change", () => {
    layout = narrow.matches ? "narrow" : "wide";
    prepare();
    restart();
  });
  reducedMotion.addEventListener("change", () => {
    paused = reducedMotion.matches;
    restart();
  });
  document.addEventListener("visibilitychange", schedule);
  new IntersectionObserver(
    ([entry]) => {
      const entering = entry.isIntersecting && !visible;
      visible = entry.isIntersecting;
      if (entering) restart();
      else schedule();
    },
    { threshold: 0.05 },
  ).observe(root);

  return { restart };
}

/** The markup a journey drives: timed blocks and flags, clocks, typed text and streamed words. */
function bindScene(root: HTMLElement, journey: Journey, skip: string) {
  const shows = [...root.querySelectorAll<HTMLElement>(`[data-show]${skip}`)].map((el) => ({ el, windows: el.dataset.show!, visible: !el.hasAttribute("hidden") }));
  // data-flag="busy:aSend~aDone;typed:>send" toggles data-busy and data-typed on the element.
  const flags = [...root.querySelectorAll<HTMLElement>("[data-flag]")].flatMap((el) =>
    el.dataset.flag!.split(";").map((flag) => {
      const [name, windows] = flag.split(":");
      return { el, attribute: `data-${name}`, windows, visible: el.hasAttribute(`data-${name}`) };
    }),
  );
  const clocks = [...root.querySelectorAll<HTMLElement>("[data-clock]")].map((el) => ({ el, from: el.dataset.clock!, template: el.dataset.clockText ?? "Working · {s}s", shown: -1 }));
  const durations = [...root.querySelectorAll<HTMLElement>("[data-duration]")];
  let typing: Typing[] = [];
  let streams: Stream[] = [];

  const toggle = (sceneSeconds: number, timeline: Timeline) => {
    for (const item of shows) {
      const next = visibleAt(item.windows, timeline, sceneSeconds);
      if (next !== item.visible) item.el.toggleAttribute("hidden", !(item.visible = next));
    }
    for (const flag of flags) {
      const next = visibleAt(flag.windows, timeline, sceneSeconds);
      if (next !== flag.visible) flag.el.toggleAttribute(flag.attribute, (flag.visible = next));
    }
  };
  const write = (sceneSeconds: number, timeline: Timeline) => {
    for (const clock of clocks) {
      const seconds = Math.max(0, Math.floor(sceneSeconds - moment(clock.from, timeline)));
      if (seconds !== clock.shown) clock.el.textContent = clock.template.replace("{s}", String((clock.shown = seconds)));
    }
    for (const item of typing) {
      const text = item.keys.findLast((key) => key.at <= sceneSeconds)?.text ?? "";
      if (text !== item.shown) item.el.textContent = item.shown = text;
    }
    for (const stream of streams) {
      const count = stream.at.filter((at) => at <= sceneSeconds).length;
      if (count !== stream.shown) stream.words.forEach((word, i) => (word.hidden = i >= (stream.shown = count)));
    }
  };
  const states = (sceneSeconds: number, timeline: Timeline, layout: Layout) => {
    for (const [name, state] of Object.entries(journey.states)) {
      const value = Object.entries(state[layout] ?? {}).find(([, windows]) => visibleAt(windows, timeline, sceneSeconds))?.[0] ?? state.rest;
      if (root.dataset[name] !== value) root.dataset[name] = value;
    }
  };

  return {
    prepare(timeline: Timeline) {
      typing = [...root.querySelectorAll<HTMLElement>("[data-type]")].map((el) => ({ el, keys: keystrokes(el, timeline), shown: null }));
      streams = [...root.querySelectorAll<HTMLElement>("[data-stream]")].map((el) => {
        const words = [...el.querySelectorAll<HTMLElement>(".hs-word")];
        return { words, at: arrivals(words.length, el.dataset.stream!, timeline), shown: words.length };
      });
      for (const el of durations) {
        const [from, to] = el.dataset.duration!.split("~");
        el.textContent = `Worked for ${Math.floor(moment(to, timeline) - moment(from, timeline))}s`;
      }
    },
    render(sceneSeconds: number, timeline: Timeline, layout: Layout) {
      toggle(sceneSeconds, timeline);
      write(sceneSeconds, timeline);
      states(sceneSeconds, timeline, layout);
    },
  };
}

/**
 * Human typing: uneven gaps, a pause after spaces and full stops, and one slip
 * that is deleted before the right letter. Keystrokes fill the typing window.
 */
function keystrokes(el: HTMLElement, timeline: Timeline) {
  const text = el.dataset.text ?? "";
  const [typoAt, typoKey] = (el.dataset.typo ?? "").split(":");
  const [start, end] = el.dataset.type!.split("~").map((name) => moment(name, timeline));
  const actions: { text: string; weight: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    // Each weight is the pause before the next keystroke.
    if (i === Number(typoAt) && typoKey) {
      actions.push({ text: text.slice(0, i) + typoKey, weight: 2.2 });
      actions.push({ text: text.slice(0, i), weight: 0.9 });
    }
    const weight = 0.65 + ((i * 17 + 3) % 9) * 0.075 + (text[i] === " " ? 0.5 : 0) + (text[i] === "." ? 2.4 : 0);
    actions.push({ text: text.slice(0, i + 1), weight });
  }
  const total = actions.reduce((sum, action) => sum + action.weight, 0);
  let elapsed = 0;
  return actions.map((action) => {
    const at = start + (elapsed / total) * (end - start);
    elapsed += action.weight;
    return { at, text: action.text };
  });
}

/** Replies arrive a few words at a time, the way streamed text lands. */
function arrivals(count: number, window: string, timeline: Timeline) {
  const [start, end] = window.split("~").map((name) => moment(name, timeline));
  const at: number[] = [];
  let word = 0;
  let chunk = 0;
  while (word < count) {
    const size = 1 + ((chunk * 7 + 2) % 3);
    const time = start + (word / count) * (end - start);
    for (let i = 0; i < size && word < count; i++, word++) at.push(time);
    chunk++;
  }
  return at;
}
