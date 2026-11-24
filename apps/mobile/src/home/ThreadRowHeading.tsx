import { subagentStatusLabel, useTicking, workDuration, type ThreadMark, type ThreadMarkKind } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import type { ReactNode } from "react";
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
export function leadReach(thread: ThreadSummary, mark: ThreadMark | null): number | null {
  const child = finished(thread);
  if (child) return finishedIcon(child.status) === X ? REACH.cross : REACH.ring;
  return markReach(mark);
}

/** Whether a row has a status glyph to show: a finished sub thread's outcome, or its mark. */
export const showsStatus = (thread: ThreadSummary, mark: ThreadMark | null): boolean => Boolean(mark || finished(thread));

/**
 * A row's state in its lead column: a finished sub thread's outcome, else its cube, moving as `kind` when its live run
 * names the work; an empty column with neither. `className` sets the column, a sub thread's 28 pt one by default.
 */
export function RowStatus({ thread, mark, kind, className = "w-7" }: { thread: ThreadSummary; mark: ThreadMark | null; kind?: ThreadMarkKind | undefined; className?: string }) {
  const child = finished(thread);
  if (!child) return <ThreadStatusMark mark={mark} kind={kind} className={className} />;
  const Icon = finishedIcon(child.status);
  return (
    <View accessibilityLabel={subagentStatusLabel[child.status]} className={cn("items-center", className)}>
      <Icon size={16} className={child.status === "failed" ? "text-bad" : "text-ink-4"} />
    </View>
  );
}

/** How far past a title's end its parent's disclosure is centered, and the room the title leaves for it. */
export const DISCLOSURE_AT = 16;

/**
 * A row's title, as wide as its words, then what is left of the line. It tells where it ends, so a parent's disclosure
 * can follow it as a project's chevron follows its name, and keeps room for that disclosure before the row's facts.
 */
export function RowTitle({ parent, onEnd, children }: { parent: boolean; onEnd: (x: number) => void; children: ReactNode }) {
  return (
    <>
      <View className="shrink" onLayout={(event) => onEnd(event.nativeEvent.layout.x + event.nativeEvent.layout.width)}>
        {children}
      </View>
      <View className={cn("flex-1", parent && "min-w-7")} />
    </>
  );
}

/**
 * A sub thread's line: its state in the lead column, where the tree's line reaches it, its title, and one fact at the
 * end, whole: for how long it has worked while it runs, then what kind of agent it was.
 */
export function ThreadRowHeading({
  thread,
  mark,
  kind,
  parent,
  onTitleEnd,
}: {
  thread: ThreadSummary;
  mark: ThreadMark | null;
  kind?: ThreadMarkKind | undefined;
  parent: boolean;
  onTitleEnd: (x: number) => void;
}) {
  const child = thread.subagent;
  const running = child?.status === "running";
  const tick = useTicking(running);
  let fact: string | null = null;
  if (child) fact = running ? workDuration(tick - child.startedAt) : child.agentType;
  return (
    <View className="flex-row items-center gap-3">
      <RowStatus thread={thread} mark={mark} kind={kind} />
      <RowTitle parent={parent} onEnd={onTitleEnd}>
        <Text numberOfLines={1} className="text-lg text-ink">
          {thread.title}
        </Text>
      </RowTitle>
      {fact ? <Text className="shrink-0 text-detail text-ink-4 tabular-nums">{fact}</Text> : null}
    </View>
  );
}
