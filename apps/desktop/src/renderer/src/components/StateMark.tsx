import { useLayoutEffect, useRef } from "react";
import { restMoment, threadMarkMotion, type DotFrame, type MarkDot, type MarkMotion, type ThreadMarkKind } from "@openorc/client";
import { cn } from "../lib/cn";
import { prefersReducedMotion } from "../lib/motion";
import "../styles/state-marks.css";

/** The side of the square a mark's dots are placed in. */
const FIELD = 24;
/** How much of its colour a dot keeps where it wears least. */
const FAINTEST = 0.45;

/**
 * A dot at one moment of its loop, as its style or a keyframe: where it is, how big, and how much of its colour shows.
 * A dot is the whole field's circle moved to its place and scaled down to its size. Placed and sized by layout, a box
 * this small is rounded to whole pixels and the lattice goes uneven.
 */
function moment(dot: MarkDot, radius: number, frame: DotFrame) {
  const place = (units: number) => `${(units / FIELD) * 100}%`;
  return {
    transform: `translate(${place(dot.x)}, ${place(dot.y)}) scale(${((radius * 2) / FIELD) * frame.size})`,
    opacity: FAINTEST + (1 - FAINTEST) * frame.ramp,
  };
}

/**
 * A state mark at `size`: its dots, each playing its own loop, in the theme's colour for what the mark says. Every
 * mark of a kind keeps the same time, so two rows at the same work move together. A dot only changes its transform
 * and opacity, which the compositor plays by itself, so a moving mark costs the interface no work. Under reduced
 * motion a moving mark holds its most telling moment. `label` is what it says aloud; a mark without one is decoration.
 */
export function StateMark({ motion, size = 16, label, className }: { motion: MarkMotion; size?: number; label?: string; className?: string }) {
  const mark = useRef<HTMLSpanElement>(null);
  const rest = restMoment(motion);
  useLayoutEffect(() => {
    const dots = mark.current?.children;
    // Where the platform cannot animate an element, the mark holds its resting moment.
    if (!motion.period || prefersReducedMotion() || !dots?.[0]?.animate) return;
    const plays = Array.from(dots, (element, index) => {
      const dot = motion.dots[index]!;
      const play = element.animate(
        [...dot.frames, dot.frames[0]!].map((frame) => moment(dot, motion.radius, frame)),
        { duration: motion.period, iterations: Infinity },
      );
      play.startTime = 0;
      return play;
    });
    return () => plays.forEach((play) => play.cancel());
  }, [motion]);
  return (
    <span
      ref={mark}
      data-tone={motion.tone}
      className={cn("state-mark", className)}
      style={{ width: size, height: size }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {motion.dots.map((dot, index) => (
        <span key={index} style={moment(dot, motion.radius, dot.frames[rest]!)} />
      ))}
    </span>
  );
}

/**
 * Something under way, as the cube at work: the light goes round. A line that stands for the whole turn names its
 * `kind` of work, so its mark moves as the thread's own does in the sidebar.
 */
export function WorkingMark({ kind = "working", size = 16, className }: { kind?: ThreadMarkKind; size?: number; className?: string }) {
  return <StateMark motion={threadMarkMotion(kind)} size={size} className={className} />;
}
