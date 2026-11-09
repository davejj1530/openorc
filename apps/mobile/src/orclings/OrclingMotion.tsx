import { ORCLING_INKS, ORCLING_SHAPES, orclingAccessory, orclingEyes, orclingGlasses } from "@openorc/client";
import type { OrclingLook } from "@openorc/protocol";
import { memo, useId, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { type CSSAnimationKeyframes } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useReducedMotion } from "../ui/reduced-motion";
import { OrclingFace, Texture } from "./OrclingFace";

/** How an Orcling moves: at rest it breathes, while it works it hops, and while it wants the person it nudges. */
export type OrclingMood = "rest" | "working" | "asking";

/** Where the drawing's parts pivot, in its 100-unit square: the body sits on y 87, every eye style centers near y 48. */
const FEET = "50% 87%";
const EYES = "50% 48%";

/** A stable number from an id, so each Orcling keeps its own pace and no two blink together. */
export function seedOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** One look around, as the desktop's Rive Orcling idles: a blink, a glance one way and the other, then a second blink. */
function eyeKeyframes(size: number, blinks: boolean): CSSAnimationKeyframes {
  const shut = blinks ? 0.1 : 1;
  const glance = size * 0.04;
  const at = (x: number, scaleY = 1) => ({ transform: [{ translateX: x }, { scaleY }] });
  return {
    "0%": at(0),
    "38%": at(0),
    "40%": at(0, shut),
    "42%": at(0),
    "52%": at(0),
    "56%": at(-glance),
    "64%": at(-glance),
    "68%": at(glance),
    "76%": at(glance),
    "80%": at(0),
    "92%": at(0),
    "94%": at(0, shut),
    "96%": at(0),
    "100%": at(0),
  };
}

function bodyKeyframes(mood: OrclingMood, size: number): CSSAnimationKeyframes {
  const pose = (translateY: number, scaleX: number, scaleY: number, rotate = "0deg") => ({ transform: [{ translateY }, { scaleX }, { scaleY }, { rotate }] });
  if (mood === "working") return { "0%": pose(0, 1, 1), "18%": pose(0, 1.04, 0.95), "45%": pose(-size * 0.08, 0.97, 1.04), "72%": pose(0, 1.04, 0.95), "86%": pose(0, 1, 1), "100%": pose(0, 1, 1) };
  if (mood === "asking")
    return {
      "0%": pose(0, 1, 1),
      "64%": pose(0, 1, 1),
      "70%": pose(0, 1, 1, "-7deg"),
      "78%": pose(0, 1, 1, "6deg"),
      "86%": pose(0, 1, 1, "-3deg"),
      "92%": pose(0, 1, 1),
      "100%": pose(0, 1, 1),
    };
  return { "0%": pose(0, 1, 1), "50%": pose(0, 0.985, 1.025), "100%": pose(0, 1, 1) };
}

const BODY_SECONDS: Record<OrclingMood, number> = { rest: 3.6, working: 1.1, asking: 2.6 };

/** The animations a face plays: its body's for its mood, and one look around every 6.5 to 9.4 seconds by its seed. */
export function faceMotion(mood: OrclingMood, size: number, seed: number, paused: boolean) {
  const playState = paused ? "paused" : "running";
  const delay: `${number}s` = `${(seed % 17) / 10}s`;
  const loop = { animationIterationCount: "infinite", animationTimingFunction: "ease-in-out", animationDelay: delay, animationPlayState: playState } as const;
  const eyes: `${number}s` = `${6.5 + (seed % 30) / 10}s`;
  return {
    body: { ...loop, animationName: bodyKeyframes(mood, size), animationDuration: `${BODY_SECONDS[mood]}s` as const },
    eyes: { ...loop, animationName: eyeKeyframes(size, true), animationDuration: eyes },
    // Glasses follow the eyes' glances, as the Rive Orcling's do, and stay open when the eyes blink.
    glasses: { ...loop, animationName: eyeKeyframes(size, false), animationDuration: eyes },
  };
}

function Layer({ size, children }: { size: number; children: ReactNode }) {
  return (
    <Svg viewBox="0 0 100 100" width={size} height={size} style={StyleSheet.absoluteFill}>
      {children}
    </Svg>
  );
}

/**
 * An Orcling alive in a list, from the same flat drawing as its still face: the body breathes, hops or nudges by its
 * mood, the eyes blink and glance, and glasses follow them. `paused` holds it while its list is out of sight; under
 * Reduce Motion it is the still face.
 */
export const OrclingMotion = memo(function OrclingMotion({ look, size, seed, mood, paused }: { look: OrclingLook; size: number; seed: number; mood: OrclingMood; paused: boolean }) {
  const still = useReducedMotion();
  const id = `motion-${useId().replace(/[^\w-]/g, "")}`;
  if (still) return <OrclingFace look={look} size={size} />;
  const body = ORCLING_SHAPES[look.shape]?.path ?? ORCLING_SHAPES[0]!.path;
  const eyes = orclingEyes(look.eyes);
  const glasses = orclingGlasses(look.glasses);
  const accessory = orclingAccessory(look.accessory);
  const motion = faceMotion(mood, size, seed, paused);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: FEET }, motion.body]}>
        <Layer size={size}>
          <Path d={body} fill={look.bodyColor} />
          <Texture id={id} body={body} look={look} />
        </Layer>
        <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: EYES }, motion.eyes]}>
          <Layer size={size}>
            <Path d={eyes.path} fill={look.eyeColor} />
            {eyes.glints ? <Path d={eyes.glints} fill={ORCLING_INKS.light} /> : null}
          </Layer>
        </Animated.View>
        {glasses ? (
          <Animated.View style={[StyleSheet.absoluteFill, motion.glasses]}>
            <Layer size={size}>
              {glasses.lenses ? <Path d={glasses.lenses} fill={ORCLING_INKS.lens} /> : null}
              <Path d={glasses.frames} fill="none" stroke={look.eyeColor} strokeWidth={3} strokeLinecap="round" />
            </Layer>
          </Animated.View>
        ) : null}
        {accessory ? (
          <Layer size={size}>
            <Path d={accessory.path} fill={accessory.fill} />
            {accessory.detail ? <Path d={accessory.detail.path} fill={accessory.detail.fill} /> : null}
          </Layer>
        ) : null}
      </Animated.View>
    </View>
  );
});
