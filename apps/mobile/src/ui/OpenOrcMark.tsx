import { StyleSheet, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { openOrcMark } from "../generated/openorc-mark";
import { useColors } from "./mode";

const { outline, faces, turn } = openOrcMark;
const sides = ["top", "right", "left"] as const;

/** One face's light while an agent works: lit, then solid while the other two take their turn, as on the desktop. */
const lit = (face: (typeof sides)[number]) =>
  ({
    animationName: Object.fromEntries(turn.stops.map(([at, opacity]) => [`${at}%`, { opacity }])),
    animationDuration: `${turn.durationMs}ms`,
    animationDelay: `${turn.delayMs[face]}ms`,
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  }) as const;

/**
 * OpenOrc's mark: a cube seen from above, solid but for its lit top face, in `color`. While an agent works the light
 * moves around the cube, one face at a time; reduced motion keeps the top lit. A lit face shows the ground it sits on.
 */
export function OpenOrcMark({ size, color, working }: { size: number; color: string; working: boolean }) {
  const still = useReducedMotion();
  const ground = useColors().bg;
  const box = { width: size, height: size };
  if (!working)
    return (
      <Svg {...box} viewBox="0 0 32 32">
        <Path fill={color} fillRule="evenodd" d={`${outline}${faces.top}`} />
      </Svg>
    );
  return (
    <View style={box}>
      <Svg {...box} viewBox="0 0 32 32">
        <Path fill={color} d={outline} />
      </Svg>
      {(still ? (["top"] as const) : sides).map((face) => (
        <Animated.View key={face} style={[StyleSheet.absoluteFill, still ? undefined : lit(face)]}>
          <Svg {...box} viewBox="0 0 32 32">
            <Path fill={ground} d={faces[face]} />
          </Svg>
        </Animated.View>
      ))}
    </View>
  );
}
