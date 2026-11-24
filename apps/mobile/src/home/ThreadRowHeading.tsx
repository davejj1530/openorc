import { subagentStatusLabel, useTicking, workDuration, type ThreadMark, type ThreadMarkKind } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { View } from "react-native";
import { CircleCheck, CircleDashed, X } from "../generated/icons";
import { cn } from "../ui/cn";
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
export function leadReach(thread: ThreadSummary, mark: ThreadMark | null, resting = false): number | null {
  const child = finished(thread);
  if (child) return finishedIcon(child.status) === X ? REACH.cross : REACH.ring;
  return markReach(mark, resting);
}

/** What a row's lead column needs: its mark, the work its live run names, and whether its sub threads show under it. */
export type RowLead = { mark: ThreadMark | null; kind: ThreadMarkKind | undefined; resting: boolean };

/** Whether a row has a status glyph to show: a finished sub thread's outcome, or its mark. */
export const showsStatus = (thread: ThreadSummary, mark: ThreadMark | null): boolean => Boolean(mark || finished(thread));

/**
 * A row's state in its lead column: a finished sub thread's outcome, else its cube, moving as `kind` when its live run
 * names the work; with neither, the resting cube while its sub threads show under it, else an empty column.
 * `className` sets the column, a sub thread's 28 pt one by default.
 */
export function RowStatus({ thread, lead, className = "w-7" }: { thread: ThreadSummary; lead: RowLead; className?: string }) {
  const child = finished(thread);
  if (!child) return <ThreadStatusMark mark={lead.mark} kind={lead.kind} resting={lead.resting} className={className} />;
  const Icon = finishedIcon(child.status);
  return (
    <View accessibilityLabel={subagentStatusLabel[child.status]} className={cn("items-center", className)}>
      <Icon size={16} className={child.status === "failed" ? "text-bad" : "text-ink-4"} />
    </View>
  );
}

/**
 * A sub thread's line: its state in the lead column, where the tree's line reaches it, its title, and one fact at the
 * end, whole: for how long it has worked while it runs, then what kind of agent it was.
 */
export function ThreadRowHeading({ thread, lead }: { thread: ThreadSummary; lead: RowLead }) {
  const child = thread.subagent;
  const running = child?.status === "running";
  const tick = useTicking(running);
  let fact: string | null = null;
  if (child) fact = running ? workDuration(tick - child.startedAt) : child.agentType;
  return (
    <View className="flex-row items-center gap-3">
      <RowStatus thread={thread} lead={lead} />
      <Text numberOfLines={1} className="flex-1 text-lg text-ink">
        {thread.title}
      </Text>
      {fact ? <Text className="shrink-0 text-detail text-ink-4 tabular-nums">{fact}</Text> : null}
    </View>
  );
}
