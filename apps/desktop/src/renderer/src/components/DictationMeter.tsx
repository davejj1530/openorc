import { useEffect, useRef } from "react";
import { dictationLevel, useDictation } from "../lib/dictation/dictation";
import { useReducedMotion } from "../lib/motion";

/** One bar and the gap after it, the bar alone, and a silent bar, which is a dot: in points. */
const PITCH = 4;
const BAR = 2;
const QUIET = 2;
/** How much of the recording one bar holds. The strip moves a pitch in that time, so it shows about the last second and a half. */
const STEP_MS = 100;

interface Bar {
  /** When the bar began to fill. */
  born: number;
  /** The loudest moment it has held. */
  level: number;
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** Draws the strip at `now`: each bar enters at the right edge as it begins to fill and moves left at one steady pace. */
function draw(canvas: HTMLCanvasElement, bars: readonly Bar[], now: number): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { clientWidth: width, clientHeight: height } = canvas;
  const scale = window.devicePixelRatio;
  if (canvas.width !== Math.round(width * scale)) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = getComputedStyle(canvas).color;
  for (const bar of bars) {
    const tall = QUIET + bar.level * (height - QUIET);
    context.beginPath();
    context.roundRect(width - BAR + PITCH - ((now - bar.born) / STEP_MS) * PITCH, (height - tall) / 2, BAR, tall, BAR / 2);
    context.fill();
  }
}

/**
 * What dictation hears, as it hears it: the voice of the last moments as bars moving off to the left, and how long it
 * has listened. The bars are the microphone's real loudness, so a pause is a row of dots and a failed microphone looks
 * like one. Drawn outside React, a frame at a time. When the recording ends the last frame stays, for the pill to fold
 * over. Under reduced motion the strip holds still as dots and only the time counts.
 */
export function DictationMeter({ active }: { active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const still = useReducedMotion();
  useEffect(() => {
    const strip = canvas.current;
    const shown = time.current;
    if (!active || !strip || !shown) return;
    const room = Math.ceil(strip.clientWidth / PITCH) + 1;
    let bars: Bar[] = Array.from({ length: room }, (_, index) => ({ born: performance.now() - (room - index) * STEP_MS, level: 0 }));
    let since: number | null = null;
    shown.textContent = clock(0);
    const tick = () => {
      const now = performance.now();
      const phase = useDictation.getState().take?.phase;
      if (phase === "listening") {
        since ??= now;
        shown.textContent = clock(now - since);
      }
      if (still) return draw(strip, bars, bars.at(-1)!.born + STEP_MS);
      let newest = bars.at(-1)!;
      newest.level = Math.max(newest.level, dictationLevel());
      // More than one bar can be due, after the window was out of sight and no frame was drawn.
      while (now - newest.born >= STEP_MS) {
        newest = { born: newest.born + STEP_MS, level: 0 };
        bars = [...bars.slice(1), newest];
      }
      draw(strip, bars, now);
    };
    if (still) {
      tick();
      const counting = setInterval(tick, 250);
      return () => clearInterval(counting);
    }
    let frame = requestAnimationFrame(function next() {
      tick();
      frame = requestAnimationFrame(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, still]);
  return (
    <>
      <canvas ref={canvas} className="composer-dictate-wave" />
      <span ref={time} className="composer-dictate-time">
        0:00
      </span>
    </>
  );
}
