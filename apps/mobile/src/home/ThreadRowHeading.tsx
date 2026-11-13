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

/** A sub thread that has finished, whose outcome its row shows; null while it runs or for a thread that is none. */
const finished = (thread: ThreadSummary): Subagent | null => (thread.subagent && thread.subagent.status !== "running" ? thread.subagent : null);

/** How far a row's lead glyph reaches left of its center on the title line, for the tree's lines; null with none. */
export function leadReach(thread: ThreadSummary, mark: ThreadMark | null): number | null {
  const child = finished(thread);
  if (child) return finishedIcon(child.status) === X ? REACH.cross : REACH.ring;
  return markReach(mark);
}

/** Whether a row has a status glyph to show: a finished sub thread's outcome, or its mark. */
export const showsStatus = (thread: ThreadSummary, mark: ThreadMark | null): boolean => Boolean(mark || finished(thread));

/** A row's status glyph in its 28 pt box: a finished sub thread's outcome, else its mark; an empty box with neither. */
export function RowStatus({ thread, mark }: { thread: ThreadSummary; mark: ThreadMark | null }) {
  const child = finished(thread);
  if (!child) return <ThreadStatusMark mark={mark} />;
  const Icon = finishedIcon(child.status);
  return (
    <View accessibilityLabel={subagentStatusLabel[child.status]} className="w-7 items-center">
      <Icon size={16} className={child.status === "failed" ? "text-bad" : "text-ink-4"} />
    </View>
  );
}

/**
 * A row's title line: the title in ink, a root's at the list's largest size, shimmering while its agent works. A root row's
 * status sits on the line under it (ThreadRow's RowMark), so the title line's end stays clear for a parent's chevron.
 * A sub thread keeps its status in the lead column, where the tree's line reaches it, and says one fact at the end,
 * whole: for how long it has worked while it runs, then what kind of agent it was.
 */
export function ThreadRowHeading({ thread, compact, mark, working = false }: { thread: ThreadSummary; compact: boolean; mark: ThreadMark | null; working?: boolean }) {
  const child = thread.subagent;
  const running = child?.status === "running";
  const tick = useTicking(running);
  let fact: string | null = null;
  if (compact && child) fact = running ? workDuration(tick - child.startedAt) : child.agentType;
  if (!compact)
    return (
      <View className="flex-row items-center gap-3">
        <SweepText text={thread.title} className="flex-1 text-xl text-ink" sweeping={working} />
      </View>
    );
  return (
    <View className="flex-row items-center gap-3">
      <RowStatus thread={thread} mark={mark} />
      <Text numberOfLines={1} className="flex-1 text-lg text-ink">
        {thread.title}
      </Text>
      {fact ? <Text className="shrink-0 text-detail text-ink-4 tabular-nums">{fact}</Text> : null}
    </View>
  );
}
