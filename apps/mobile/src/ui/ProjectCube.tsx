import { PROJECT_CUBE, type ProjectActivity } from "@openorc/client";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useColors } from "./mode";
import { useReducedMotion } from "./reduced-motion";

// The top face breathes while a project's threads work, as the desktop's does.
const breathe = { "50%": { opacity: 0.45 } };
const STROKE = { strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/**
 * A project's mark: the OpenOrc cube as an open frame, the place its threads' cubes live in, in the ink of the label
 * it leads. Its top face is empty while the project is quiet, fills in the theme's working ink while its threads work,
 * breathing slowly, and wears the attention colour when one of them needs the person. It is decoration: its label
 * names the project and counts what waits.
 */
export function ProjectCube({ activity, size = 18 }: { activity: ProjectActivity; size?: number }) {
  const colors = useColors();
  const still = useReducedMotion();
  const top = activity === "attention" ? colors.attention : colors["working-ink"];
  const box = { width: size, height: size };
  return (
    <View pointerEvents="none" style={box}>
      {activity === "quiet" ? null : (
        <Animated.View
          style={[
            { position: "absolute" },
            activity === "working" && !still ? { animationName: breathe, animationDuration: "2400ms", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" } : null,
          ]}
        >
          <Svg viewBox="0 0 24 24" {...box}>
            <Path d={PROJECT_CUBE.top} fill={top} stroke={top} {...STROKE} />
          </Svg>
        </Animated.View>
      )}
      <Svg viewBox="0 0 24 24" {...box}>
        <Path d={PROJECT_CUBE.frame} fill="none" stroke={colors["ink-3"]} {...STROKE} />
        <Path d={PROJECT_CUBE.seams} fill="none" stroke={colors["ink-3"]} {...STROKE} />
      </Svg>
    </View>
  );
}
