import { cubicBezier, Easing } from "react-native-reanimated";
import { motion } from "../generated/tokens";

const [o1, o2, o3, o4] = motion.ease.out;
const [s1, s2, s3, s4] = motion.ease.overshoot;

/** The desktop's motion tokens for Reanimated: CSS-style animations take `cubicBezier`, timing animations `Easing`. */
export const ease = {
  out: cubicBezier(o1, o2, o3, o4),
  overshoot: cubicBezier(s1, s2, s3, s4),
  outTiming: Easing.bezier(o1, o2, o3, o4),
  overshootTiming: Easing.bezier(s1, s2, s3, s4),
};

/** Arriving: fade in while rising 4 pt, over 220 ms. The desktop's blur has no cheap native equivalent and is left out. */
export const arrive = {
  animationName: { from: { opacity: 0, transform: [{ translateY: motion.arrive.rise }] }, to: { opacity: 1, transform: [{ translateY: 0 }] } },
  animationDuration: `${motion.duration.arrive}ms`,
  animationTimingFunction: ease.out,
} as const;

/** How long the rows under an opening fold get to move first, so the rows arriving never land on them. */
const LEAD = 70;

/**
 * Arriving as one of a fold's rows, `at` rows into it: after the lead, the desktop's 40 ms stagger, capped near eight
 * rows. It starts hidden, since the animation attaches a frame after the row first draws.
 */
export const arriveAt = (at: number) => ({ ...arrive, opacity: 0, animationDelay: `${LEAD + motion.stagger * Math.min(at, 8)}ms`, animationFillMode: "both" }) as const;

/** Leaving: fading out over 160 ms and staying out, while what held it folds. */
export const leave = {
  animationName: { to: { opacity: 0 } },
  animationDuration: `${motion.duration.leave}ms`,
  animationTimingFunction: ease.out,
  animationFillMode: "forwards",
} as const;

/** A disclosure's chevron turning as what it holds opens or folds, over the resize time. */
export const turn = (open: boolean, still: boolean) =>
  ({
    transform: [{ rotate: open ? "180deg" : "0deg" }],
    transitionProperty: "transform",
    transitionDuration: still ? 0 : motion.duration.resize,
    transitionTimingFunction: ease.out,
  }) as const;

/** A confirmation: from half size to full with one overshoot. */
export const confirm = {
  animationName: { from: { opacity: 0, transform: [{ scale: 0.5 }] }, to: { opacity: 1, transform: [{ scale: 1 }] } },
  animationDuration: `${motion.duration.confirm}ms`,
  animationTimingFunction: ease.overshoot,
} as const;

/** The desktop's spinner turn. */
export const spin = {
  animationName: { to: { transform: [{ rotate: "360deg" }] } },
  animationDuration: "1.2s",
  animationIterationCount: "infinite",
  animationTimingFunction: "linear",
} as const;
