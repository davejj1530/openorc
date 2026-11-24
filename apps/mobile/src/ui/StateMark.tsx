import { mixHex, restMoment, type DotFrame, type MarkMotion, type MarkTone } from "@openorc/client";
import { memo } from "react";
import { View, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { useColors, type Palette } from "./mode";
import { useReducedMotion } from "./reduced-motion";

/** The palette's role each tone wears: the theme's own colour for what a mark says. */
const ROLES: Record<MarkTone, keyof Palette> = { work: "working-ink", think: "tone-think", ink: "ink", attention: "attention", bad: "bad", ok: "ok", quiet: "ink-3" };
/** How much of its colour a dot keeps at its palest, as the desktop's sheet fades it into the ground. */
const PALEST = 0.45;

/** A dot at one moment of its loop: its size, and its colour from faded into the ground to whole. */
const moment = (frame: DotFrame, color: string, ground: string) => ({ transform: [{ scale: frame.size }], backgroundColor: mixHex(ground, color, PALEST + frame.ramp * (1 - PALEST)) });

/** A dot's loop as keyframes, ending where it began. */
function loop(frames: DotFrame[], color: string, ground: string) {
  const keys: Record<string, ReturnType<typeof moment>> = { "100%": moment(frames[0]!, color, ground) };
  frames.forEach((frame, index) => (keys[`${((index / frames.length) * 100).toFixed(2)}%`] = moment(frame, color, ground)));
  return keys;
}

/**
 * A state mark at `size` points: its dots, each a disc playing its own loop on the UI thread, in the theme's colour
 * for what the mark says. Under reduced motion a moving mark holds its most telling moment. It is decoration: what it
 * says is in its row's label.
 */
export const StateMark = memo(function StateMark({ motion, size = 20 }: { motion: MarkMotion; size?: number }) {
  const colors = useColors();
  const still = useReducedMotion();
  const unit = size / 24;
  const rest = restMoment(motion);
  const moving = motion.period > 0 && !still;
  const color = colors[ROLES[motion.tone]];
  return (
    <View pointerEvents="none" style={{ width: size, height: size }}>
      {motion.dots.map((dot, index) => {
        const disc: ViewStyle = {
          position: "absolute",
          left: (dot.x + 12 - motion.radius) * unit,
          top: (dot.y + 12 - motion.radius) * unit,
          width: 2 * motion.radius * unit,
          height: 2 * motion.radius * unit,
          borderRadius: motion.radius * unit,
        };
        return moving ? (
          <Animated.View
            key={index}
            style={[disc, { animationName: loop(dot.frames, color, colors.bg), animationDuration: `${motion.period}ms`, animationIterationCount: "infinite", animationTimingFunction: "linear" }]}
          />
        ) : (
          <View key={index} style={[disc, moment(dot.frames[rest]!, color, colors.bg)]} />
        );
      })}
    </View>
  );
});
