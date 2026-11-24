import { Linking, Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import { DEVICE } from "../device";
import { Check, Mic, X } from "../generated/icons";
import { motion } from "../generated/tokens";
import { cn } from "../ui/cn";
import { ease } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import { Text } from "../ui/Text";
import type { DictationNoticeKind, DictationPhase } from "./dictation";
import { DictationMeter, DictationTime } from "./DictationMeter";

/** The composer's microphone at rest, beside send: a quiet glyph of the bar's own, as attach is. */
export function DictationKey({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Dictate" onPress={onPress} hitSlop={8} className="h-control-sm w-7 items-center justify-center rounded-full active:bg-surface-2">
      <Mic size={16} className="text-ink-4" />
    </Pressable>
  );
}

/** The pill opening: in from the side the microphone was on, over the arrive time. */
const unfold = {
  animationName: { from: { opacity: 0, transform: [{ translateX: 12 }] }, to: { opacity: 1, transform: [{ translateX: 0 }] } },
  animationDuration: `${motion.duration.arrive}ms`,
  animationTimingFunction: ease.out,
} as const;

/** The dot's breath while the microphone is open: full to half and back, slow enough to sit beside the time. */
const breathe = {
  animationName: { from: { opacity: 1 }, to: { opacity: 0.5 } },
  animationDuration: "1600ms",
  animationTimingFunction: "ease-in-out",
  animationIterationCount: "infinite",
  animationDirection: "alternate",
} as const;

/** The dot every recorder shows. It breathes while the microphone is open and rests dim before and after. */
function RecordingDot({ open }: { open: boolean }) {
  const still = useReducedMotion();
  return <Animated.View className={cn("size-1.5 rounded-full bg-recording", !open && "opacity-35")} style={open && !still ? breathe : undefined} />;
}

/**
 * Dictating: the bar gives its room to the recording, as one pill. Cancel stands at its start, a circle inside its
 * round end, and takes the words back out. The rest finishes and keeps them: the voice as it was just heard, the red
 * dot of a recording with how long it has listened, and a check where the microphone was.
 */
export function DictationPill({ phase, since, onFinish, onCancel }: { phase: DictationPhase; since: number | null; onFinish: () => void; onCancel: () => void }) {
  const still = useReducedMotion();
  return (
    <Animated.View className="min-w-0 flex-1 flex-row justify-end" style={still ? undefined : unfold}>
      <View className="h-control-send min-w-0 max-w-80 flex-1 flex-row items-center rounded-full bg-key pl-0.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel dictation"
          onPress={onCancel}
          hitSlop={{ top: 8, bottom: 8, left: 8 }}
          className="size-7 items-center justify-center rounded-full active:bg-surface-3"
        >
          <X size={14} className="text-ink-3" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Finish dictating"
          accessibilityState={{ busy: phase !== "listening" }}
          disabled={phase === "finishing"}
          onPress={onFinish}
          hitSlop={{ top: 8, bottom: 8 }}
          className="min-w-0 flex-1 flex-row items-center gap-2.5 self-stretch pl-2 pr-3 active:opacity-60"
        >
          <DictationMeter />
          <View className="flex-row items-center gap-1.5">
            <RecordingDot open={phase === "listening"} />
            <DictationTime since={since} />
          </View>
          <Check size={16} className="text-ink" />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const words: Record<DictationNoticeKind, string> = {
  microphone: "Microphone access for OpenOrc is off.",
  unavailable: `On-device dictation isn't available for this ${DEVICE}'s language.`,
  stopped: "Dictation stopped.",
};

/** Why the microphone did not start or stopped, said in the composer, with the way to Settings where that helps. */
export function DictationNotice({ kind }: { kind: DictationNoticeKind }) {
  return (
    <View className="flex-row items-center gap-3">
      <Text accessibilityRole="alert" className="min-w-0 flex-shrink text-sm text-ink-4">
        {words[kind]}
      </Text>
      {kind === "microphone" ? (
        <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} hitSlop={10} className="active:opacity-60">
          <Text className="text-sm text-ink-2">Open Settings</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
