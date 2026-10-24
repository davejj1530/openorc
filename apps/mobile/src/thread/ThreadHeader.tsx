import { threadMark } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";
import { useRpc, useRpcMutation } from "../client";
import { Square } from "../generated/icons";
import { Text } from "../ui/Text";

/** The header's faint line: where the thread lives, then what it is doing when that is worth saying. */
function statusLine(thread: ThreadSummary, project: string | undefined): string {
  const mark = threadMark(thread);
  const doing = mark && (mark.kind === "running" || mark.kind === "waiting" || mark.kind === "failed") ? mark.label : null;
  return [thread.projectId === WORKSPACE_ID ? "Workspace" : project, doing].filter(Boolean).join(" · ");
}

/** The thread's title over a faint line of where it lives and what it is doing. */
export function ThreadTitle({ thread }: { thread: ThreadSummary | null }) {
  const projects = useRpc("projects.list", {});
  const project = projects.data?.find((item) => item.id === thread?.projectId)?.name;
  if (!thread) return null;
  const line = statusLine(thread, project);
  return (
    <View accessibilityRole="header" className="max-w-60 items-center">
      <Text numberOfLines={1} className="text-md leading-5">
        {thread.title}
      </Text>
      {line ? (
        <Text numberOfLines={1} className="text-xs leading-4 text-ink-4">
          {line}
        </Text>
      ) : null}
    </View>
  );
}

/** Stop in the header while a turn runs: ends the turn and keeps the session warm. */
export function ThreadStop({ runId }: { runId: string }) {
  const interrupt = useRpcMutation("runs.interrupt");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Stop"
      disabled={interrupt.isPending}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        interrupt.mutate({ runId });
      }}
      hitSlop={8}
      className="size-8 items-center justify-center rounded-full bg-surface-2 active:bg-surface-3"
    >
      <Square size={14} className={interrupt.isPending ? "text-ink-4" : "text-ink"} />
    </Pressable>
  );
}
