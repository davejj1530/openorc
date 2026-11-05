import { ownerMark, relativeTime, subagentStatusLabel, threadHeadline, threadMark, threadPlace, type ThreadHeadline, type ThreadPlace, type ThreadTreeRow } from "@openorc/client";
import { harnessShortName, isHarnessId, isSubagentThread, type ThreadSummary } from "@openorc/protocol";
import { Link } from "expo-router";
import { memo, useContext, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { HostContext } from "../connection/host-context";
import { Folder, GitBranch, GitPullRequest } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { ListPressable } from "../ui/ListPressable";
import { swipeAccessibility, type SwipeAction } from "../ui/swipe";
import { SwipeRow } from "../ui/SwipeRow";
import { Text } from "../ui/Text";
import { markThreadOpening } from "../thread/perf-probe";
import { threadMenu, threadSwipes } from "../thread/thread-actions";
import { rowMenu } from "../thread/ThreadMenu";
import { useSnoozeClock } from "../thread/snooze-clock";
import { useThreadActions } from "../thread/use-thread-actions";
import { useRowRun } from "./row-run";
import { macAsleep, MAC_ASLEEP } from "./out-of-reach";
import { STILL, type RowMotion } from "./fold-motion";
import { ACTION_RESERVE } from "./grid";
import { ThreadTreeFrame, treeIndent, TreeToggle } from "./ThreadBranch";
import { leadReach, ThreadRowHeading } from "./ThreadRowHeading";

const placeIcons: Record<ThreadPlace["kind"], ComponentType<IconProps>> = { branch: GitBranch, pull: GitPullRequest, folder: Folder };
// The desktop's headline tones (ThreadHeadline.css).
const headlineTones: Record<ThreadHeadline["tone"], string> = { live: "text-ink-3", attention: "text-warn", done: "text-ink-4" };

/** Where it works, who works on it and when it last moved: the details a row keeps for its menu and for VoiceOver. */
function rowFacts(thread: ThreadSummary, where: string): string[] {
  return [where, isHarnessId(thread.agent) ? harnessShortName(thread.agent) : thread.agent, relativeTime(thread.lastActivityAt)];
}

/** The row's second line, under the title: the live headline in its tone, else where the thread works. */
function RowLine({ headline, where, Icon }: { headline: ThreadHeadline | null; where: string; Icon: ComponentType<IconProps> }) {
  return (
    <View className="ml-10 flex-row items-center gap-1.5">
      {headline ? null : <Icon size={14} className="text-ink-4" />}
      <Text numberOfLines={1} className={cn("flex-1 text-detail text-ink-4", headline && headlineTones[headline.tone])}>
        {headline?.text ?? where}
      </Text>
    </View>
  );
}

/** A row of a Mac out of reach: dimmed, and a tap says why it does nothing. */
function AsleepRow({ label, className, style, children }: { label: string; className: string; style: ViewStyle; children: ReactNode }) {
  const [explained, setExplained] = useState(false);
  return (
    <ListPressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setExplained((shown) => !shown)} className={className} style={style}>
      <View className="gap-1 opacity-60">{children}</View>
      {explained ? <Text className="ml-10 mt-1 text-detail text-ink-3">{MAC_ASLEEP}</Text> : null}
    </ListPressable>
  );
}

/**
 * The desktop sidebar's thread row at touch size: the status lead, the muted title, and a second line. That line is the
 * live headline while there is something to say (the step the agent is on, what it waits for, what a finished turn
 * came to), and otherwise where the thread works. The row holds the thread's live run, so the run's frames arrive.
 * Tapping it pushes the thread; holding it opens the thread's menu; swiping marks it read or unread, or archives it.
 * A row of a Mac the phone cannot reach shows from the last list, dimmed, with where it works: a tap says why it does
 * nothing, and it has no swipes or menu, since nothing would reach the Mac.
 */
/** How a row sits in its project's tree: its padding and height, its disclosure's state and how it moves. */
function treePlace(tree: ThreadTreeRow | undefined, motion: RowMotion, arriving: boolean) {
  const compact = Boolean(tree?.depth);
  return {
    compact,
    rowClass: cn("mx-3 rounded-lg bg-bg px-2 active:bg-surface-2", compact ? "min-h-touch justify-center py-2.75" : "gap-1 py-2"),
    rowStyle: { paddingLeft: 8 + treeIndent(tree?.depth ?? 0), paddingRight: ACTION_RESERVE },
    open: Boolean(tree?.expanded && !motion.folding),
    moves: motion.arrive === undefined && arriving ? { ...motion, arrive: 0 } : motion,
  };
}

/** Whether two of a row's tree places draw the same, as Home builds new ones on every list read. */
function sameTree(a: ThreadTreeRow | undefined, b: ThreadTreeRow | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.thread === b.thread &&
    a.depth === b.depth &&
    a.hasChildren === b.hasChildren &&
    a.expanded === b.expanded &&
    a.last === b.last &&
    a.hiddenChildren === b.hiddenChildren &&
    a.visibleChildren === b.visibleChildren &&
    a.continuing.join() === b.continuing.join()
  );
}

export const ThreadRow = memo(
  function ThreadRow({
    thread,
    project,
    arriving,
    tree,
    motion = STILL,
    onFold,
  }: {
    thread: ThreadSummary;
    project: string | null;
    arriving: boolean;
    tree?: ThreadTreeRow;
    motion?: RowMotion;
    /** Opens or folds a parent's sub threads: its id, and whether to open them. */
    onFold?: (id: string, open: boolean) => void;
  }) {
    const run = useRowRun(thread.liveRunId ?? undefined);
    const asleep = macAsleep(thread.owner);
    const live = useMemo(() => threadHeadline(thread, run), [thread, run]);
    // What it was doing when the Mac last answered is no longer happening.
    const headline = asleep ? null : live;
    const actions = useThreadActions(thread);
    const now = useSnoozeClock();
    const { compact, rowClass, rowStyle, open, moves } = treePlace(tree, motion, arriving);
    const child = thread.subagent;
    const mark = threadMark(thread);
    const place = threadPlace(thread);
    const owner = ownerMark(thread);
    const host = useContext(HostContext);
    const where = [project, place.label, owner?.label].filter(Boolean).join(" · ");
    const facts = rowFacts(thread, where);
    const swipes = threadSwipes(thread);
    const leading: SwipeAction | undefined = isSubagentThread(thread) ? undefined : { label: swipes.leading.label, tone: "review", run: () => actions.save(swipes.leading.patch) };
    const trailing: SwipeAction | undefined = swipes.trailing ? { label: swipes.trailing.label, tone: "accent", run: () => actions.save(swipes.trailing!.patch) } : undefined;
    const label = [thread.title, child ? subagentStatusLabel[child.status] : mark?.label, child?.agentType, compact ? null : headline?.text, ...facts].filter(Boolean).join(", ");
    const lines = (
      <>
        <ThreadRowHeading thread={thread} compact={compact} mark={mark} />
        {compact ? null : <RowLine headline={headline} where={where} Icon={placeIcons[place.kind]} />}
      </>
    );
    const toggle = <TreeToggle tree={tree} open={open} compact={compact} onFold={onFold} />;
    if (asleep)
      return (
        <ThreadTreeFrame tree={tree} reach={leadReach(thread, mark)} motion={moves} compact={compact}>
          <AsleepRow label={label} className={rowClass} style={rowStyle}>
            {lines}
          </AsleepRow>
          {toggle}
        </ThreadTreeFrame>
      );
    return (
      <ThreadTreeFrame tree={tree} reach={leadReach(thread, mark)} motion={moves} compact={compact}>
        <SwipeRow id={thread.id} leading={leading} trailing={trailing}>
          <View>
            <Link href={{ pathname: "/thread/[id]", params: host ? { id: thread.id, host } : { id: thread.id } }} push dangerouslySingular asChild onPress={() => markThreadOpening(thread.id)}>
              <Link.Trigger>
                <ListPressable accessibilityRole="button" accessibilityLabel={label} {...swipeAccessibility([leading, trailing])} className={cn(rowClass, owner?.dim && "opacity-60")} style={rowStyle}>
                  {lines}
                </ListPressable>
              </Link.Trigger>
              {rowMenu(threadMenu(thread, "row", now), actions.run, { title: thread.title, subtitle: facts.join(" · ") })}
            </Link>
            {toggle}
          </View>
        </SwipeRow>
      </ThreadTreeFrame>
    );
  },
  // A fold moving re-renders Home; only the rows it touches should draw again.
  (before, next) =>
    before.thread === next.thread &&
    before.project === next.project &&
    before.arriving === next.arriving &&
    before.motion === next.motion &&
    before.onFold === next.onFold &&
    sameTree(before.tree, next.tree),
);
