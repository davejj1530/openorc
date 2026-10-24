import Animated from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import type { LinkTone } from "../connection/link-words";
import type { ColorToken } from "../generated/tokens";
import { useColors } from "./mode";
import { useReducedMotion } from "./reduced-motion";

/** Each tone's color. Not trying reads stronger than on its way: a Mac that cannot be reached is the louder news. */
export const linkInk: Record<LinkTone, ColorToken> = { ok: "ok", busy: "ink-4", attention: "attention", off: "ink-3" };

const SIZE = 8;
const STROKE = 1.5;

/** On its way: a slow breath, which reduced motion holds still. */
const breathe = {
  animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } },
  animationDuration: "2400ms",
  animationIterationCount: "infinite",
  animationTimingFunction: "ease-in-out",
} as const;

/**
 * The connection's state as a small mark; whatever shows it carries the words. Filled only while connected: any other
 * state draws a ring, because on Home a filled dot is a thread's unread mark, and an amber ring under the wordmark must
 * not read as one more unread thread.
 */
export function LinkDot({ tone }: { tone: LinkTone }) {
  const still = useReducedMotion();
  const ink = useColors()[linkInk[tone]];
  const filled = tone === "ok";
  return (
    <Animated.View testID="link-dot" style={tone === "busy" && !still ? breathe : undefined}>
      <Svg width={SIZE} height={SIZE}>
        <Circle cx={SIZE / 2} cy={SIZE / 2} r={filled ? SIZE / 2 : (SIZE - STROKE) / 2} fill={filled ? ink : "none"} stroke={filled ? undefined : ink} strokeWidth={filled ? undefined : STROKE} />
      </Svg>
    </Animated.View>
  );
}
