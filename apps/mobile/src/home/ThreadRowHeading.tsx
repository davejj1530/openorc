import { subagentStatusLabel, useTicking, workDuration, type ThreadMark } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { View } from "react-native";
import { CircleCheck, CircleDashed, X } from "../generated/icons";
import { SweepText } from "../ui/SweepText";
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
 * A row's title line: the muted title at reading size, lighting up left to right while its agent works, with what the
 * thread needs from you at its end. A sub thread keeps its
 * status in the lead column, where the tree's line reaches it, and says one fact at the end, whole: for how long it has
 * worked while it runs, then what kind of agent it was.
 */
export function ThreadRowHeading({ thread, compact, mark, working = false }: { thread: ThreadSummary; compact: boolean; mark: ThreadMark | null; working?: boolean }) {
  const child = thread.subagent;
  const running = child?.status === "running";
  const tick = useTicking(running);
  const Icon = child && !running ? finishedIcon(child.status) : null;
  let fact: string | null = null;
  if (compact && child) fact = running ? workDuration(tick - child.startedAt) : child.agentType;
  const lead =
    Icon && child ? (
      <View accessibilityLabel={subagentStatusLabel[child.status]} className="w-7 items-center">
        <Icon size={16} className={child.status === "failed" ? "text-bad" : "text-ink-4"} />
      </View>
    ) : (
      <ThreadStatusMark mark={mark} />
    );
  if (!compact)
    return (
      <View className="flex-row items-center gap-3">
        <SweepText text={thread.title} className="flex-1 text-lg text-ink-3" sweeping={working} />
        {Icon || mark ? lead : null}
      </View>
    );
  return (
    <View className="flex-row items-center gap-3">
      {lead}
      <Text numberOfLines={1} className="flex-1 text-lg text-ink-3">
        {thread.title}
      </Text>
      {fact ? <Text className="shrink-0 text-detail text-ink-4 tabular-nums">{fact}</Text> : null}
    </View>
  );
}
