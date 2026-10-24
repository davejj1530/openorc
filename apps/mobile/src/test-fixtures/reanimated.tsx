import { useEffect, useRef } from "react";
import { ScrollView, View } from "./react-native";

/** Whether the reader asked iOS to reduce motion; a test turns it on here. */
export const motion = { reduced: false };

const Animated = { View, ScrollView };
export default Animated;
export const useReducedMotion = () => motion.reduced;
export const cubicBezier = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 });
export const Easing = { bezier: cubicBezier };
export const useSharedValue = <T,>(value: T) => ({ value });
export const useAnimatedStyle = (style: () => object) => style();
export const useFrameCallback = () => undefined;
/** A reaction runs once its view has mounted, as on the UI thread, with nothing before it. */
export const useAnimatedReaction = <T,>(prepare: () => T, react: (now: T, before: T | null) => void) => useEffect(() => react(prepare(), null));
export const withTiming = <T,>(value: T) => value;
export const withSpring = <T,>(value: T) => value;
/** A scroll view's ref, and its offset, which stays at the top as nothing scrolls here; a test passes its own offset instead. */
export const useAnimatedRef = () => useRef(null);
export const useScrollOffset = () => ({ value: 0 });

export const Extrapolation = { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" } as const;

/** Reanimated's interpolate between two points, held at the ends when asked to clamp. */
export function interpolate(value: number, input: readonly number[], output: readonly number[], extrapolate?: string): number {
  const [from, to] = input as [number, number];
  const [low, high] = output as [number, number];
  const at = to === from ? 1 : (value - from) / (to - from);
  const clamped = extrapolate === Extrapolation.CLAMP ? Math.min(1, Math.max(0, at)) : at;
  return low + (high - low) * clamped;
}
