import { threadMarkMotion, type ThreadMark, type ThreadMarkKind } from "@openorc/client";
import { View } from "react-native";
import { cn } from "../ui/cn";
import { StateMark } from "../ui/StateMark";

/** The cube's size in a row, and how far it reaches left of its center on the title line: the tree's lines stop short of it. */
export const MARK_SIZE = 20;
export const MARK_REACH = 9;
/** How far the resting cube reaches: only its heart shows. */
export const RESTING_REACH = 5.5;
/** How far a finished sub thread's 16 pt glyph reaches: a ring (8.5 of 24 plus half the 1.75 stroke), a cross's arm (6 of 24). */
export const REACH = { ring: 6.25, cross: 4.6 } as const;

/** The cube for a mark that says only its thread's state, where no live run names the work. */
const kindOf = (mark: ThreadMark): ThreadMarkKind => {
  if (mark.kind === "pull") return mark.state;
  const kinds: Record<Exclude<ThreadMark["kind"], "pull">, ThreadMarkKind> = {
    waiting: "question",
    "waiting-other": "waiting",
    running: "working",
    failed: "failed",
    unread: "done",
    background: "background",
    mention: "mention",
  };
  return kinds[mark.kind];
};

/** How far a row's cube reaches from its center, so the tree's lines can stop a set gap short of it; null with none. */
export function markReach(mark: ThreadMark | null, resting = false): number | null {
  if (mark) return MARK_REACH;
  return resting ? RESTING_REACH : null;
}

/**
 * A row's cube in Home's lead column, centered under the headings' marks. `kind` is the work its live run names, when
 * the row holds one. With nothing to report the column is empty, unless the row is `resting`: its sub threads show
 * under it, and it wears the resting cube for their tree to hang from. `className` sets the column: a sub thread's
 * 28 pt one unless the row says otherwise.
 */
export function ThreadStatusMark({ mark, kind, resting = false, className = "w-7" }: { mark: ThreadMark | null; kind?: ThreadMarkKind | undefined; resting?: boolean; className?: string }) {
  const shown = mark ? (kind ?? kindOf(mark)) : null;
  const cube = shown ?? (resting ? "resting" : null);
  return (
    <View className={cn("h-5 items-center justify-center", className)} accessible={mark !== null} accessibilityLabel={mark?.label}>
      {cube ? <StateMark motion={threadMarkMotion(cube)} size={MARK_SIZE} /> : null}
    </View>
  );
}
