import { turnStatus, turnStatusWords, useTicking } from "@openorc/client";
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

type EndRow = Extract<Row, { kind: "end" }>;

type CopyState = "idle" | "copied" | "failed";

const labels: Record<CopyState, string> = { idle: "Copy message", copied: "Message copied", failed: "Could not copy message" };

/**
 * The end of a turn: where it stands, "Working 12s" while it runs and "Worked for 41s" once done, swapping in place,
 * then Copy for its reply once done. One row, one height, from the turn's start to its end, so finishing moves nothing.
 * On a touch screen it all stays in view, as the desktop's does without hover. A turn loaded from history mounts in its
 * final state and does not animate. Copy widens just enough to say so, a fill and "Copied" in place, then gives them back.
 */
export const TurnEnd = memo(function TurnEnd({ row }: { row: EndRow }) {
  const now = useTicking(row.live);
  const status = turnStatus(row, now);
  const words = turnStatusWords(status);
  // The status this end first showed in this view; a view the list recycles starts over for its new turn.
  const [first] = useRowState(row.key, () => status.kind);
  const swapped = status.kind !== first;
  return (
    <View className="-ml-1.75 flex-row items-center" style={{ height: FIXED_HEIGHT.end }}>
      {words ? <StatusWords key={status.kind} failed={status.kind === "failed"} arrive={swapped} words={words} /> : null}
      {row.text === null ? null : <CopyReply rowKey={row.key} text={row.text} />}
    </View>
  );
});

function StatusWords({ words, failed, arrive: rise }: { words: string; failed: boolean; arrive: boolean }) {
  const still = useReducedMotion();
  return (
    <Animated.View className="px-1.75" style={rise && !still ? arrive : undefined}>
      <Text numberOfLines={1} className={cn("text-xs leading-4 tabular-nums", failed ? "text-bad" : "text-ink-4")}>
        {words}
      </Text>
    </Animated.View>
  );
}

function CopyReply({ rowKey, text }: { rowKey: string; text: string }) {
  const [state, setState] = useRowState<CopyState>(rowKey, () => "idle");
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
  );
}
