import * as Clipboard from "expo-clipboard";
import { memo, useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { Check, Copy } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { arrive, confirm } from "../ui/motion";
import { Text } from "../ui/Text";
import { useRowState } from "./row-state";
import { FIXED_HEIGHT, type Row } from "./rows";

type ActionsRow = Extract<Row, { kind: "actions" }>;

type CopyState = "idle" | "copied" | "failed";

const labels: Record<CopyState, string> = { idle: "Copy message", copied: "Message copied", failed: "Could not copy message" };

/**
 * The end of a finished turn: copy its reply. On a touch screen the action stays in view, as the desktop's does
 * without hover. Copy widens just enough to say so, a fill and "Copied" in place, then gives them back.
 */
export const TurnActions = memo(function TurnActions({ row }: { row: ActionsRow }) {
  const { text } = row;
  const [state, setState] = useRowState<CopyState>(row.key, () => "idle");
  const still = useReducedMotion();
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state, setState]);
  const copy = () =>
    Clipboard.setStringAsync(text).then(
      () => {
        setState("copied");
        haptic.tap();
      },
      () => setState("failed"),
    );
  return (
    <View className="-ml-1.75 flex-row items-center" style={{ height: FIXED_HEIGHT.actions }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={labels[state]}
        onPress={() => void copy()}
        hitSlop={8}
        className={cn("h-control-md min-w-7.5 flex-row items-center justify-center gap-1.5 rounded-full px-1.75 active:bg-surface-2", state !== "idle" && "bg-surface")}
      >
        {state === "copied" ? (
          <Animated.View style={still ? undefined : confirm}>
            <Check size={16} className="text-ink" />
          </Animated.View>
        ) : (
          <Copy size={16} className={state === "failed" ? "text-bad" : "text-ink-4"} />
        )}
        {state === "idle" ? null : (
          <Animated.View style={still ? undefined : arrive}>
            <Text className={cn("text-xs leading-4", state === "failed" ? "text-bad" : "text-ink")}>{state === "copied" ? "Copied" : "Failed"}</Text>
          </Animated.View>
        )}
      </Pressable>
    </View>
  );
});
