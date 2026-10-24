import { View } from "./react-native";

/** Whether the reader asked iOS to reduce motion; a test turns it on here. */
export const motion = { reduced: false };

const Animated = { View };
export default Animated;
export const useReducedMotion = () => motion.reduced;
export const cubicBezier = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 });
export const Easing = { bezier: cubicBezier };
export const useSharedValue = <T,>(value: T) => ({ value });
export const useAnimatedStyle = (style: () => object) => style();
export const useFrameCallback = () => undefined;
