import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { restMoment, threadMarkMotion, type DotFrame, type MarkMotion, type ThreadMarkKind } from "@openorc/client";
import { cn } from "../lib/cn";
import { prefersReducedMotion } from "../lib/motion";
import "../styles/state-marks.css";

/** A dot at one moment of its loop, as its style or a keyframe. */
const moment = (frame: DotFrame) => ({ transform: `scale(${frame.size})`, "--mark-wear": frame.ramp });

/**
 * A state mark at `size`: its dots, each playing its own loop, in the theme's colour for what the mark says. Every
 * mark of a kind keeps the same time, so two rows at the same work move together. Under reduced motion a moving mark
 * holds its most telling moment. `label` is what it says aloud; a mark without one is decoration.
 */
export function StateMark({ motion, size = 16, label, className }: { motion: MarkMotion; size?: number; label?: string; className?: string }) {
  const mark = useRef<SVGSVGElement>(null);
  const rest = restMoment(motion);
  useLayoutEffect(() => {
    const dots = mark.current?.children;
    // Where the platform cannot animate an element, the mark holds its resting moment.
    if (!motion.period || prefersReducedMotion() || !dots?.[0]?.animate) return;
    const plays = Array.from(dots, (dot, index) => {
      const frames = motion.dots[index]!.frames;
      const play = dot.animate([...frames, frames[0]!].map(moment), { duration: motion.period, iterations: Infinity });
      play.startTime = 0;
      return play;
    });
    return () => plays.forEach((play) => play.cancel());
  }, [motion]);
  return (
    <svg
      ref={mark}
      viewBox="-12 -12 24 24"
      width={size}
      height={size}
      data-tone={motion.tone}
      className={cn("state-mark", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {motion.dots.map((dot, index) => (
        <circle key={index} cx={dot.x} cy={dot.y} r={motion.radius} style={moment(dot.frames[rest]!) as CSSProperties} />
      ))}
    </svg>
  );
}

/**
 * Something under way, as the cube at work: the light goes round. A line that stands for the whole turn names its
 * `kind` of work, so its mark moves as the thread's own does in the sidebar.
 */
export function WorkingMark({ kind = "working", size = 16, className }: { kind?: ThreadMarkKind; size?: number; className?: string }) {
  return <StateMark motion={threadMarkMotion(kind)} size={size} className={className} />;
}
