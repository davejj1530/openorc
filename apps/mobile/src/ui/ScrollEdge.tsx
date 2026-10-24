import { StyleSheet } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, type SharedValue } from "react-native-reanimated";

/** Points of scroll over which the hairline comes in, as iOS draws a bar's edge once content passes under it. */
const FADE = 8;

/** The hairline under a pinned bar: none at the top of the content, in once the content scrolls under the bar. */
export function ScrollEdge({ scrollY }: { scrollY: SharedValue<number> }) {
  const shown = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [0, FADE], [0, 1], Extrapolation.CLAMP) }));
  return <Animated.View testID="scroll-edge" pointerEvents="none" className="absolute inset-x-0 bottom-0 bg-line" style={[{ height: StyleSheet.hairlineWidth }, shown]} />;
}
