import { memo, useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useReducedMotion } from "../ui/reduced-motion";
import { Text } from "../ui/Text";
import { dictation } from "./phone-dictation";

/** One bar and the gap after it, the bar alone, a silent bar (a dot) and the loudest one: in points. */
const PITCH = 4;
const BAR = 2;
const QUIET = 2;
const TALL = 18;
/** How much of the recording one bar holds. The strip moves a pitch in that time, so a phone shows about its last four seconds. */
const STEP_MS = 100;
/** The bars at the leading edge that fade out, so the strip leaves instead of being cut. */
const FADE = 6;

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** One bar: as tall as the loudest moment it held, fading as it reaches the leading edge. */
const Bar = memo(function Bar({ at, levels, shift }: { at: number; levels: SharedValue<number[]>; shift: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    height: QUIET + (levels.value[at] ?? 0) * (TALL - QUIET),
    opacity: Math.min(1, Math.max(0, (at - shift.value) / FADE)),
  }));
  return <Animated.View className="bg-ink-2" style={[{ width: BAR, borderRadius: BAR / 2 }, style]} />;
});

/**
 * What dictation hears, as it hears it: the voice of the last moments as bars moving off to the leading edge. The
 * bars are the microphone's real loudness, so a pause is a row of dots and a microphone that hears nothing looks like
 * one. They are moved a frame at a time off the JavaScript thread, so words arriving never make them stutter. Under
 * reduced motion the strip holds still as dots.
 */
function Strip({ width }: { width: number }) {
  const still = useReducedMotion();
  const count = Math.ceil(width / PITCH) + 1;
  const levels = useSharedValue<number[]>([]);
  // How far into its step the newest bar is, from 0 to 1.
  const shift = useSharedValue(0);
  const born = useSharedValue(0);
  // The loudest the microphone has been since the last frame read it.
  const loud = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    const reading = setInterval(() => {
      loud.value = Math.max(loud.value, dictation.level());
    }, 30);
    return () => clearInterval(reading);
  }, [still, loud]);
  useFrameCallback((frame) => {
    const now = frame.timestamp;
    let bars = levels.value;
    if (bars.length !== count) {
      bars = Array.from({ length: count }, () => 0);
      born.value = now;
    }
    // More than one bar can be due, after the app was out of sight and no frame was drawn.
    const due = Math.min(count, Math.floor((now - born.value) / STEP_MS));
    if (due > 0) {
      bars = [...bars.slice(due), ...Array.from({ length: due }, () => 0)];
      born.value += due * STEP_MS;
    }
    const newest = bars.length - 1;
    if (loud.value > (bars[newest] ?? 0)) {
      bars = bars.slice();
      bars[newest] = loud.value;
    }
    loud.value = 0;
    if (bars !== levels.value) levels.value = bars;
    shift.value = (now - born.value) / STEP_MS;
  }, !still);
  // The newest bar enters from past the trailing edge and the row moves a pitch a step.
  const moving = useAnimatedStyle(() => ({ transform: [{ translateX: (1 - shift.value) * PITCH }] }));
  return (
    <Animated.View className="absolute inset-y-0 right-0 flex-row items-center" style={[{ gap: PITCH - BAR }, moving]}>
      {Array.from({ length: count }, (_, at) => (
        <Bar key={at} at={at} levels={levels} shift={shift} />
      ))}
    </Animated.View>
  );
}

/** The strip in the room it is given, and nothing until that room is known. */
export function DictationMeter() {
  const [width, setWidth] = useState(0);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="min-w-0 flex-1 self-stretch overflow-hidden"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 ? <Strip width={width} /> : null}
    </View>
  );
}

/** How long the recording has listened, counted from when it began to hear. */
export function DictationTime({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const counting = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(counting);
  }, [since]);
  return <Text className="text-sm tabular-nums text-ink-3">{clock(since === null ? 0 : Math.max(0, now - since))}</Text>;
}
