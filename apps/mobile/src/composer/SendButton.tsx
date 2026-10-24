import type { ComponentType } from "react";
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { ArrowUp, Clock } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { ease } from "../ui/motion";
import { motion } from "../generated/tokens";

export type SendState = "send" | "queue" | "stop";

const labels: Record<SendState, string> = { send: "Send", queue: "Queue", stop: "Stop" };

function StopGlyph() {
  return <View className="size-2.5 bg-accent-fg" style={{ borderRadius: 2 }} />;
}

const glyphs: Record<SendState, ComponentType<IconProps>> = { send: ArrowUp, queue: Clock, stop: StopGlyph };

/** One layer of the pill: in from half size with an overshoot when it becomes the state, out quickly when it leaves. */
function Layer({ state, current, disabled }: { state: SendState; current: SendState; disabled: boolean }) {
  const still = useReducedMotion();
  const on = state === current;
  const Glyph = glyphs[state];
  return (
    <Animated.View
      className="absolute inset-0 items-center justify-center"
      style={{
        opacity: on ? 1 : 0,
        transform: [{ scale: on ? 1 : 0.5 }],
        ...(still ? {} : { transitionProperty: ["opacity", "transform"], transitionDuration: [motion.duration.leave, motion.duration.confirm], transitionTimingFunction: [ease.out, ease.overshoot] }),
      }}
    >
      <Glyph size={16} className={disabled || state === "queue" ? "text-ink-3" : "text-accent-fg"} />
    </Animated.View>
  );
}

/**
 * The composer's one ink control, 32 pt. Send, Queue and Stop are layers of the same pill, so a turn starting or
 * ending swaps the glyph in place with a small overshoot instead of replacing the button. A new thread's send says Start.
 */
export function SendButton({ state, disabled, onPress, label }: { state: SendState; disabled: boolean; onPress: () => void; label?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? labels[state]}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      className={cn("h-control-send w-8 rounded-full bg-accent active:opacity-80", state === "queue" && "bg-surface-3", disabled && "bg-surface-3")}
    >
      {(["send", "queue", "stop"] as const).map((layer) => (
        <Layer key={layer} state={layer} current={state} disabled={disabled} />
      ))}
    </Pressable>
  );
}
