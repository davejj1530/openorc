import { StyleSheet } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useColors } from "./mode";

/** Points over which content fades into the ground at a pinned edge, and of scroll over which the top one comes in. */
export const FADE = 16;

function Ramp({ id, stops }: { id: string; stops: readonly [offset: number, opacity: number][] }) {
  const ground = useColors().bg;
  return (
    <Svg pointerEvents="none" width="100%" height="100%" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          {stops.map(([offset, opacity]) => (
            <Stop key={offset} offset={offset} stopColor={ground} stopOpacity={opacity} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/**
 * Where content passes under a pinned bar it fades into the ground instead of meeting a divider. The fade hangs under
 * the bar and comes in once the content scrolls under it, as iOS draws a bar's edge.
 */
export function TopFade({ scrollY }: { scrollY: SharedValue<number> }) {
  const shown = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [0, FADE], [0, 1], Extrapolation.CLAMP) }));
  return (
    <Animated.View testID="scroll-edge" pointerEvents="none" className="absolute inset-x-0" style={[{ bottom: -FADE, height: FADE }, shown]}>
      <Ramp
        id="top-fade"
        stops={[
          [0, 1],
          [1, 0],
        ]}
      />
    </Animated.View>
  );
}

/**
 * The ground a floating pill stands on at the foot of a list: rows fade out over the top `FADE * 2` points of
 * `height`, and the rest is solid ground, so nothing reads through the pill's edges.
 */
export function FootFade({ height }: { height: number }) {
  return (
    <Animated.View pointerEvents="none" className="absolute inset-x-0 bottom-0" style={{ height }}>
      <Ramp
        id="foot-fade"
        stops={[
          [0, 0],
          [Math.min(1, (FADE * 2) / height), 1],
          [1, 1],
        ]}
      />
    </Animated.View>
  );
}
