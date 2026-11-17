import {
  initials,
  latestActivity,
  pullRequestMark,
  relativeTime,
  rowAge,
  rowFacts,
  rowStarter,
  subagentStatusLabel,
  togetherActivity,
  threadHeadline,
  threadMark,
  threadPlace,
  threadStatus,
  type ThreadMark,
  type ThreadTreeRow,
  useSidebarNow,
} from "@openorc/client";
import { harnessShortName, isHarnessId, isSubagentThread, placeOf, type PrState, type ThreadSummary } from "@openorc/protocol";
import { Link } from "expo-router";
import { memo, useMemo, type ComponentType } from "react";
import { Image, useWindowDimensions, View } from "react-native";
import { Cloud, GitMerge, GitPullRequest, GitPullRequestClosed } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { ListPressable } from "../ui/ListPressable";
import { swipeAccessibility, type SwipeAction } from "../ui/swipe";
import { SwipeRow } from "../ui/SwipeRow";
import { SweepText } from "../ui/SweepText";
import { Text } from "../ui/Text";
import { useCloudOutOfReach } from "../spaces/cloud-reach";
import { markThreadOpening } from "../thread/perf-probe";
import { threadMenu, threadSwipes } from "../thread/thread-actions";
import { rowMenu } from "../thread/ThreadMenu";
import { useSnoozeClock } from "../thread/snooze-clock";
import { useThreadActions } from "../thread/use-thread-actions";
import { useRowRun } from "./row-run";
import { STILL, type RowMotion } from "./fold-motion";
import { ACTION_INSET, ACTION_RESERVE, CHROME_SCALE, ROW_INSET, titleMid } from "./grid";
import { ThreadTreeFrame, treeIndent, TreeToggle } from "./ThreadBranch";
import { leadReach, RowStatus, ThreadRowHeading } from "./ThreadRowHeading";

const pullIcons: Record<PrState, ComponentType<IconProps>> = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed };
// The desktop's pull request tones.
const pullTones: Record<PrState, string> = { open: "text-ink-4", merged: "text-ok", closed: "text-bad" };

/** Where it works, who works on it and when it last moved: the details a row keeps for its menu. */
function menuFacts(thread: ThreadSummary, where: string): string[] {
  return [where, isHarnessId(thread.agent) ? harnessShortName(thread.agent) : thread.agent, relativeTime(thread.lastActivityAt)];
}

/**
 * An OpenOrc Cloud thread's place, as the Mac's sidebar marks one: the cloud, its project, and the teammate who started
 * it when it is not the person's own. The cloud dims while the Mac cannot reach it. Null for a thread of this Mac.
 */
export function cloudPlace(thread: ThreadSummary, project: string | null, outOfReach = false): { spoken: string; offline: boolean } | null {
  if (!placeOf(thread).rowIcon) return null;
  const name = project ?? thread.owner?.project?.name ?? null;
  const starter = rowStarter(thread);
  return {
    spoken: [name, "OpenOrc Cloud", starter ? `started by ${starter.name}` : null].filter(Boolean).join(", "),
    offline: outOfReach || thread.owner?.reach !== "live",
  };
}

/** How far a root row's mark reaches past the line's end, so its 28 pt box centers on the action column. */
const MARK_PULL = ACTION_INSET - ROW_INSET - 14 - ACTION_RESERVE;
/** The age's column, wide enough for "11mo", so ages end on one line down the list. */
const AGE_WIDTH = 32;

/** A teammate's face in a 16 pt fact slot: their picture, else their initials on a quiet fill, as the desktop's. */
function StarterFace({ name, image }: { name: string; image: string | null }) {
  if (image) return <Image source={{ uri: image }} accessibilityIgnoresInvertColors className="size-3.5 rounded-full" />;
  return (
    <View className="size-3.5 items-center justify-center rounded-full bg-surface-3">
      <Text maxFontSizeMultiplier={1} className="text-ink-2" style={{ fontSize: 7, lineHeight: 9 }}>
        {initials(name)}
      </Text>
    </View>
  );
}

/**
 * A root row's facts, as the desktop's row packs them before its state: who started it when it is someone else, its
 * pull request in its state's tone, and the cloud for an OpenOrc Cloud thread whose group's label does not wear it,
 * dimmed while out of reach. Each sits in a 16 pt slot; absent facts leave their room to the title, while the age and
 * the mark keep their columns. What they say is in the row's label.
 */
function FactSlots({ thread, cloudLabel }: { thread: ThreadSummary; cloudLabel: boolean }) {
  const starter = rowStarter(thread);
  const pull = pullRequestMark(thread);
  const place = cloudPlace(thread, null, useCloudOutOfReach());
  // Under a group whose label wears the cloud, the label says it, and dims for its rows while out of reach.
  const cloud = cloudLabel ? null : place;
  const PullIcon = pull ? pullIcons[pull.state] : null;
  if (!starter && !pull && !cloud) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {starter ? (
        <View className="size-4 items-center justify-center">
          <StarterFace name={starter.name} image={starter.image} />
        </View>
      ) : null}
      {PullIcon && pull ? (
        <View className="size-4 items-center justify-center">
          <PullIcon size={14} className={pullTones[pull.state]} />
        </View>
      ) : null}
      {cloud ? (
        // The glyph takes its ink from its class; its fade is the view's.
        <View className={cn("size-4 items-center justify-center", cloud.offline && "opacity-40")}>
          <Cloud size={14} className="text-ink-4" />
        </View>
      ) : null}
    </View>
  );
}

/**
 * A root row's one line, as the desktop sidebar's: the title, lighting up while its agent works, then its facts, its
 * age in a fixed column and its state's mark in a fixed box out in the action column, so ages and marks line up down
 * the list. A parent's disclosure holds the action column, so its facts, age and mark step left of it as one, as the
 * desktop's do. Words the row once said under its title (where it works, what it is doing) are in its label.
 */
function RootLine({ thread, mark, working, parent, cloudLabel }: { thread: ThreadSummary; mark: ThreadMark | null; working: boolean; parent: boolean; cloudLabel: boolean }) {
  const age = rowAge(latestActivity(thread), useSidebarNow());
  const scale = Math.min(useWindowDimensions().fontScale, CHROME_SCALE);
  return (
    <View className="flex-row items-center gap-3">
      <SweepText text={thread.title} className="flex-1 text-xl text-ink" sweeping={working} />
      <FactSlots thread={thread} cloudLabel={cloudLabel} />
      <View className="flex-row items-center gap-1">
        <Text numberOfLines={1} className="text-right text-detail tabular-nums text-ink-4" style={{ width: AGE_WIDTH * scale }}>
          {age}
        </Text>
        <View pointerEvents="none" style={parent ? undefined : { marginRight: MARK_PULL }}>
          <RowStatus thread={thread} mark={mark} />
        </View>
      </View>
    </View>
  );
}

/**
 * What VoiceOver says of a row, whole, where its line shows marks: its title and state, then what it is about (for a root
 * row what the agent is on, who started it, where it works and its pull request; for a sub thread its kind), then its facts.
 */
function rowLabel(thread: ThreadSummary, { state, about }: { state: string | undefined; about: (string | null | undefined)[] }, facts: string[]): string {
  return [thread.title, state, ...about, ...facts].filter(Boolean).join(", ");
}

/** What a row says of its thread's state: a root row's pull request has its own slot among its facts. */
function rowMarks(thread: ThreadSummary, compact: boolean) {
  const status = threadStatus(thread);
  const working = !compact && status?.kind === "running";
  return { status, working, mark: compact ? threadMark(thread) : status };
}

/**
 * The desktop sidebar's thread row at touch size: one line, the title in ink and the row's facts, age and mark at its
 * end. The row holds the thread's live run, so the run's frames arrive and its label says what the agent is on.
 * Tapping it pushes the thread; holding it opens the thread's menu; swiping marks it read or unread, or archives it.
 */
/** How a row sits in its project's tree: its padding, its disclosure's state and how it moves. One height for every row. */
function treePlace(tree: ThreadTreeRow | undefined, motion: RowMotion, arriving: boolean) {
  const compact = Boolean(tree?.depth);
  return {
    compact,
    rowClass: cn("mx-3 min-h-touch justify-center rounded-lg bg-bg px-2 active:bg-surface-2", compact ? "py-2.75" : "py-2.5"),
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
    cloudLabel = false,
    onFold,
  }: {
    thread: ThreadSummary;
    project: string | null;
    arriving: boolean;
    tree?: ThreadTreeRow;
    /** Its group's label wears the cloud, so its row need not. */
    cloudLabel?: boolean;
    motion?: RowMotion;
    /** Opens or folds a parent's sub threads: its id, and whether to open them. */
    onFold?: (id: string, open: boolean) => void;
  }) {
    const run = useRowRun(thread.liveRunId ?? undefined);
    // In a cloud thread someone else is in, whose turn or ask it is says more than "Working", as the thread's header does.
    const headline = useMemo(() => togetherActivity(thread) ?? threadHeadline(thread, run), [thread, run]);
    const actions = useThreadActions(thread);
    const now = useSnoozeClock();
    const { compact, rowClass, rowStyle, open, moves } = treePlace(tree, motion, arriving);
    const child = thread.subagent;
    const { status, working, mark } = rowMarks(thread, compact);
    const place = threadPlace(thread);
    const fontScale = useWindowDimensions().fontScale;
    const cloud = cloudPlace(thread, project);
    const where = cloud?.spoken ?? [project, place.label].filter(Boolean).join(" · ");
    const facts = menuFacts(thread, where);
    const detail = rowFacts(thread, { now: useSidebarNow(), ...(project ? { project } : {}) }).detail;
    const swipes = threadSwipes(thread);
    const leading: SwipeAction | undefined = isSubagentThread(thread) ? undefined : { label: swipes.leading.label, tone: "review", run: () => actions.save(swipes.leading.patch) };
    const trailing: SwipeAction | undefined = swipes.trailing ? { label: swipes.trailing.label, tone: "accent", run: () => actions.save(swipes.trailing!.patch) } : undefined;
    const label = rowLabel(
      thread,
      compact
        ? { state: child ? subagentStatusLabel[child.status] : (mark ?? status)?.label, about: [child?.agentType] }
        : { state: status?.label, about: [headline?.text, detail, pullRequestMark(thread)?.label] },
      facts,
    );
    const lines = compact ? (
      <ThreadRowHeading thread={thread} mark={mark} />
    ) : (
      <RootLine thread={thread} mark={mark} working={working} parent={Boolean(tree?.hasChildren && onFold)} cloudLabel={cloudLabel} />
    );
    // A root row's own tree line drops from under its title's first letters.
    const node = compact ? undefined : { mid: titleMid(false, fontScale) + 12 * Math.min(fontScale, CHROME_SCALE), reach: 0 };
    const toggle = <TreeToggle tree={tree} open={open} compact={compact} onFold={onFold} />;
    return (
      <ThreadTreeFrame tree={tree} reach={leadReach(thread, mark)} node={node} motion={moves} compact={compact}>
        <SwipeRow id={thread.id} leading={leading} trailing={trailing}>
          <View>
            <Link href={{ pathname: "/thread/[id]", params: { id: thread.id } }} push dangerouslySingular asChild onPress={() => markThreadOpening(thread.id)}>
              <Link.Trigger>
                <ListPressable accessibilityRole="button" accessibilityLabel={label} {...swipeAccessibility([leading, trailing])} className={rowClass} style={rowStyle}>
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
    before.cloudLabel === next.cloudLabel &&
    before.arriving === next.arriving &&
    before.motion === next.motion &&
    before.onFold === next.onFold &&
    sameTree(before.tree, next.tree),
);
