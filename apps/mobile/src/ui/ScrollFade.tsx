import { StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useColors } from "./mode";

/** Points over which content fades into the ground at a pinned edge. */
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
