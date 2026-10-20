import { duration, journeys, moment, stateAt, visibleAt, type Journey, type Layout, type SceneId, type Timeline } from "../data/hero";
import { createMotion, watchWidth } from "./hero-motion";

/** How long a replay fades the scene out before its first moment comes back, in seconds. */
const REWIND_SECONDS = 0.45;
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
 * Where a scene is: resting on a moment with the clock stopped, fading out before it starts over, or playing once
 * through to its last moment, where it rests again.
 */
type Phase = { name: "rest" } | { name: "rewind"; seconds: number } | { name: "play" };

/**
 * Plays a scene's journey against the markup its SceneFrame renders. The scene state is a function of time, so a
 * scene rests on its last moment until asked to play, plays once, and pauses its clock while it is off screen.
 * Reduced motion keeps it on its last moment.
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
  let phase: Phase = { name: "rest" };
  let elapsedSeconds = 0;
  let previousFrameMs: number | null = null;
  let lastRenderedSeconds = -1;
  let frameRequest = 0;
  let visible = false;

  const end = () => moment("end", timeline);
  const prepare = () => {
    timeline = journey.timelines[layout];
    motion?.prepare(timeline);
    scene.prepare(timeline);
  };
  const render = (sceneSeconds: number) => {
    scene.render(sceneSeconds, timeline, layout);
    lastRenderedSeconds = sceneSeconds;
  };

  const tick = (now: number) => {
    frameRequest = 0;
    const step = previousFrameMs === null ? 0 : Math.min(now - previousFrameMs, MAX_FRAME_ELAPSED_MS) / 1000;
    previousFrameMs = now;
    if (phase.name === "rewind") {
      phase.seconds += step;
      if (phase.seconds < REWIND_SECONDS) return schedule();
      phase = { name: "play" };
      elapsedSeconds = 0;
      lastRenderedSeconds = -1;
      root.removeAttribute("data-fading");
    } else elapsedSeconds = Math.min(elapsedSeconds + step, end());
    // The fixtures change in words and short state transitions. Thirty updates
    // per second keep typing fluid without walking every scene node each frame.
    if (elapsedSeconds - lastRenderedSeconds >= RENDER_INTERVAL_SECONDS || elapsedSeconds === end()) render(elapsedSeconds);
    if (elapsedSeconds < end()) motion?.render(elapsedSeconds);
    else {
      motion?.settle(elapsedSeconds);
      phase = { name: "rest" };
    }
    schedule();
  };

  const schedule = () => {
    const running = phase.name !== "rest" && visible && !document.hidden;
    root.toggleAttribute("data-paused", !running);
    if (running && !frameRequest) frameRequest = requestAnimationFrame(tick);
    if (!running) {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      previousFrameMs = null;
    }
  };

  /** Stops on the last moment. */
  const rest = () => {
    phase = { name: "rest" };
    elapsedSeconds = end();
    root.removeAttribute("data-fading");
    render(elapsedSeconds);
    motion?.settle(elapsedSeconds);
    schedule();
  };

  /** Plays the journey once from its first moment. */
  const start = () => {
    if (reducedMotion.matches) return rest();
    phase = { name: "play" };
    elapsedSeconds = 0;
    root.removeAttribute("data-fading");
    render(0);
    motion?.render(0);
    schedule();
  };

  /** Fades out whatever moment shows, then plays the journey once from its first. */
  const replay = () => {
    if (reducedMotion.matches) return rest();
    phase = { name: "rewind", seconds: 0 };
    root.setAttribute("data-fading", "");
    schedule();
  };

  prepare();
  root.setAttribute("data-engine", "");
  rest();

  // Sizes the motion layer measured follow the frame's width.
  if (motion)
    watchWidth(root, () => {
      motion.prepare(timeline);
      if (phase.name === "rest") motion.settle(lastRenderedSeconds);
    });

  narrow.addEventListener("change", () => {
    layout = narrow.matches ? "narrow" : "wide";
    prepare();
    rest();
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) rest();
  });
  document.addEventListener("visibilitychange", schedule);
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    },
    { threshold: 0.05 },
  ).observe(root);

  return { start, replay };
}

export type ScenePlayer = ReturnType<typeof initHeroScene>;

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
  const clocks = [...root.querySelectorAll<HTMLElement>("[data-clock]")].map((el) => ({ el, from: el.dataset.clock!, template: el.dataset.clockText ?? "{t}", shown: -1 }));
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
      if (seconds !== clock.shown) clock.el.textContent = clock.template.replace("{t}", duration((clock.shown = seconds)));
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
      const value = stateAt(state, layout, timeline, sceneSeconds);
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
        el.textContent = duration(Math.floor(moment(to, timeline) - moment(from, timeline)));
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
