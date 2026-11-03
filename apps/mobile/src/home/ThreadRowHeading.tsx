import { subagentStatusLabel, useTicking, workDuration, type ThreadMark } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { View } from "react-native";
import { CircleCheck, CircleDashed, X } from "../generated/icons";
import { Text } from "../ui/Text";
import { ThreadStatusMark } from "./ThreadStatusMark";

export function ThreadRowHeading({ thread, compact, mark }: { thread: ThreadSummary; compact: boolean; mark: ThreadMark | null }) {
  const child = thread.subagent;
  const tick = useTicking(child?.status === "running");
  let Icon = X;
  if (child?.status === "completed") Icon = CircleCheck;
  if (child?.status === "no_updates") Icon = CircleDashed;
  return (
    <View className="flex-row items-center gap-2">
      {child && child.status !== "running" ? (
        <View accessibilityLabel={subagentStatusLabel[child.status]} className="size-4 items-center justify-center">
          <Icon size={14} className={child.status === "failed" ? "text-bad" : "text-ink-4"} />
        </View>
      ) : (
        <ThreadStatusMark mark={mark} />
      )}
      <Text numberOfLines={1} className="flex-1 text-md leading-5 text-ink-3">
        {thread.title}
      </Text>
      {compact && child ? (
        <View className="max-w-16 items-end">
          {child.agentType ? (
            <Text numberOfLines={1} className="text-xs text-ink-4">
              {child.agentType}
            </Text>
          ) : null}
          {child.status === "running" ? <Text className="text-xs text-ink-4 tabular-nums">{workDuration(tick - child.startedAt)}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
