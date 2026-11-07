import { subagentStatusLabel, useTicking, workDuration } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { router } from "expo-router";
import { Pressable, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState, useRpc, useRpcMutation } from "../client";
import { Text } from "../ui/Text";

export function SubagentStatusBar({ thread, onLayout }: { thread: ThreadSummary; onLayout: (event: LayoutChangeEvent) => void }) {
  const child = thread.subagent;
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const model = models.data?.find((option) => option.agent === thread.agent && option.id === thread.model)?.label ?? thread.model;
  const now = useTicking(child?.status === "running");
  const stop = useRpcMutation("subagents.stop");
  const connected = useLinkState().kind === "connected";
  const insets = useSafeAreaInsets();
  return (
    <View onLayout={onLayout} className="gap-1 bg-bg px-4 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
      <View className="flex-row items-center justify-between gap-2">
        <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-ink-4">
          {[model, thread.effort].filter(Boolean).join(" · ")}
        </Text>
        {child ? (
          <Text className="text-xs text-ink-4 tabular-nums">
            {subagentStatusLabel[child.status]} · {workDuration((child.endedAt ?? now) - child.startedAt)}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center justify-between">
        {thread.parentThreadId ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/thread/[id]", params: { id: thread.parentThreadId! } })}
            className="min-h-touch justify-center rounded-full px-2 active:bg-surface-2"
          >
            <Text className="text-sm text-ink-3">Open parent</Text>
          </Pressable>
        ) : (
          <View />
        )}
        {child?.stoppable && connected ? (
          <Pressable
            accessibilityRole="button"
            disabled={stop.isPending}
            onPress={() => stop.mutate({ threadId: thread.id })}
            className="min-h-touch justify-center rounded-full bg-surface px-4 active:bg-surface-2"
          >
            <Text className="text-sm">{stop.isPending ? "Stopping…" : "Stop"}</Text>
          </Pressable>
        ) : null}
      </View>
      {stop.error ? (
        <Text accessibilityRole="alert" className="text-xs text-bad">
          {stop.error.message}
        </Text>
      ) : null}
    </View>
  );
}
