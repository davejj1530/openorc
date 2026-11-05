import { subagentStatusLabel, useTicking, workDuration, type ThreadMark } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { View } from "react-native";
import { CircleCheck, CircleDashed, X } from "../generated/icons";
import { Text } from "../ui/Text";
import { markReach, REACH, ThreadStatusMark } from "./ThreadStatusMark";

type Subagent = NonNullable<ThreadSummary["subagent"]>;

/** A finished sub thread's glyph: a check when it completed, a dashed ring when it went quiet, a cross otherwise. */
const finishedIcon = (status: Subagent["status"]) => {
  if (status === "completed") return CircleCheck;
  return status === "no_updates" ? CircleDashed : X;
};

/** How far a row's lead glyph reaches left of its center on the title line, for the tree's lines; null with none. */
export function leadReach(thread: ThreadSummary, mark: ThreadMark | null): number | null {
  const child = thread.subagent;
  if (child && child.status !== "running") return finishedIcon(child.status) === X ? REACH.cross : REACH.ring;
  return markReach(mark);
}

/**
 * A row's title line: its status in the lead column and the muted title at reading size. A sub thread says one fact at
 * the end, whole: for how long it has worked while it runs, then what kind of agent it was.
 */
export function ThreadRowHeading({ thread, compact, mark }: { thread: ThreadSummary; compact: boolean; mark: ThreadMark | null }) {
  const child = thread.subagent;
  const running = child?.status === "running";
  const tick = useTicking(running);
  const Icon = child && !running ? finishedIcon(child.status) : null;
  let fact: string | null = null;
  if (compact && child) fact = running ? workDuration(tick - child.startedAt) : child.agentType;
  return (
    <View className="flex-row items-center gap-3">
      {Icon && child ? (
        <View accessibilityLabel={subagentStatusLabel[child.status]} className="w-7 items-center">
          <Icon size={16} className={child.status === "failed" ? "text-bad" : "text-ink-4"} />
        </View>
      ) : (
        <ThreadStatusMark mark={mark} />
      )}
      <Text numberOfLines={1} className="flex-1 text-lg text-ink-3">
        {thread.title}
      </Text>
      {fact ? <Text className="shrink-0 text-detail text-ink-4 tabular-nums">{fact}</Text> : null}
    </View>
  );
}
