import { Linking, Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import { DEVICE } from "../device";
import { Check, Mic, X } from "../generated/icons";
import { motion } from "../generated/tokens";
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

/**
 * Dictating: the bar gives its room to the recording. A pill shows the voice as it was just heard and how long it has
 * listened, with a check where the microphone was, since pressing the pill finishes and keeps the words. Cancel
 * stands before it, and takes them back out.
 */
export function DictationPill({ phase, since, onFinish, onCancel }: { phase: DictationPhase; since: number | null; onFinish: () => void; onCancel: () => void }) {
  const still = useReducedMotion();
  return (
    <Animated.View className="min-w-0 flex-1 flex-row items-center justify-end gap-2" style={still ? undefined : unfold}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel dictation"
        onPress={onCancel}
        hitSlop={6}
        className="size-8 items-center justify-center rounded-full bg-surface-2 active:bg-surface-3"
      >
        <X size={14} className="text-ink-3" />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Finish dictating"
        accessibilityState={{ busy: phase !== "listening" }}
        disabled={phase === "finishing"}
        onPress={onFinish}
        className="h-control-send min-w-0 max-w-80 flex-1 flex-row items-center gap-2.5 rounded-full bg-surface-2 pl-3.5 pr-3 active:bg-surface-3"
      >
        <DictationMeter />
        <DictationTime since={since} />
        <Check size={16} className="text-ink" />
      </Pressable>
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
