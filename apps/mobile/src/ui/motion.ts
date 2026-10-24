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
