import {
  latestActivity,
  pullRequestMark,
  pullRequestNumber,
  relativeTime,
  rowAge,
  rowStarter,
  subagentStatusLabel,
  togetherActivity,
  threadHeadline,
  threadMark,
  threadPlace,
  threadStatus,
  type ThreadHeadline,
  type ThreadMark,
  type ThreadTreeRow,
  useSidebarNow,
} from "@openorc/client";
import { harnessShortName, isHarnessId, isSubagentThread, placeOf, WORKSPACE_ID, type PrState, type ThreadSummary } from "@openorc/protocol";
import { Link } from "expo-router";
import { memo, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import { Cloud, Folder, GitMerge, GitPullRequest, GitPullRequestClosed, Globe } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { ListPressable } from "../ui/ListPressable";
import { swipeAccessibility, type SwipeAction } from "../ui/swipe";
import { SwipeRow } from "../ui/SwipeRow";
import { Text } from "../ui/Text";
import { useCloudOutOfReach } from "../spaces/cloud-reach";
import { markThreadOpening } from "../thread/perf-probe";
import { threadMenu, threadSwipes } from "../thread/thread-actions";
import { rowMenu } from "../thread/ThreadMenu";
import { useSnoozeClock } from "../thread/snooze-clock";
import { useThreadActions } from "../thread/use-thread-actions";
import { useRowRun } from "./row-run";
import { STILL, type RowMotion } from "./fold-motion";
import { ACTION_INSET, ACTION_RESERVE, ROW_INSET } from "./grid";
import { ThreadTreeFrame, treeIndent, TreeToggle } from "./ThreadBranch";
import { leadReach, RowStatus, showsStatus, ThreadRowHeading } from "./ThreadRowHeading";

const pullIcons: Record<PrState, ComponentType<IconProps>> = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed };
// The desktop's pull request tones.
const pullTones: Record<PrState, string> = { open: "text-ink-4", merged: "text-ok", closed: "text-bad" };
/** How far a project glyph reaches below its line's center, for the tree's line leaving it. */
const NODE_REACH = 6;
/** Where a root row's project line is centered before it lays out: the 8 pt padding, the title's 24 pt line, the 4 pt gap and half an 18 pt line. */
const NODE_MID = 8 + 24 + 4 + 9;
// The desktop's headline tones (ThreadHeadline.css).
const headlineTones: Record<ThreadHeadline["tone"], string> = { live: "text-ink-4", attention: "text-warn", done: "text-ink-4", muted: "text-ink-4" };

/** Where it works, who works on it and when it last moved: the details a row keeps for its menu and for VoiceOver. */
function rowFacts(thread: ThreadSummary, where: string): string[] {
  return [where, isHarnessId(thread.agent) ? harnessShortName(thread.agent) : thread.agent, relativeTime(thread.lastActivityAt)];
}

/**
 * An OpenOrc Cloud thread's place, as the Mac's sidebar marks one: the cloud in the folder's place, its project, and
 * the teammate who started it when it is not the person's own. The cloud dims while the Mac cannot reach it. Null for
 * a thread of this Mac.
 */
export function cloudPlace(thread: ThreadSummary, project: string | null, outOfReach = false): { line: string; spoken: string; offline: boolean } | null {
  if (!placeOf(thread).rowIcon) return null;
  const name = project ?? thread.owner?.project?.name ?? null;
  const starter = rowStarter(thread);
  return {
    line: [name, starter?.first].filter(Boolean).join(" · "),
    spoken: [name, "OpenOrc Cloud", starter ? `started by ${starter.name}` : null].filter(Boolean).join(", "),
    offline: outOfReach || thread.owner?.reach !== "live",
  };
}

/** How far a root row's mark reaches past its line's end, so its 28 pt box centers on the action column. */
const MARK_PULL = ACTION_INSET - ROW_INSET - 14 - ACTION_RESERVE;

/**
 * A root row's mark at the end of the line under its title, out in the action column: a spinner, a question, a failure,
 * an unread dot or a finished sub thread's outcome all sit in this one place, under a parent's chevron.
 */
function RowMark({ thread, mark }: { thread: ThreadSummary; mark: ThreadMark | null }) {
  if (!showsStatus(thread, mark)) return null;
  return (
    <View pointerEvents="none" style={{ marginRight: MARK_PULL }}>
      <RowStatus thread={thread} mark={mark} />
    </View>
  );
}

/** The live headline under the title while there is something to say, in its tone, with the row's mark at its end. */
function HeadlineLine({ headline, trailing }: { headline: ThreadHeadline | null; trailing: ReactNode }) {
  if (!headline) return null;
  return (
    <View className="flex-row items-center gap-3">
      <Text numberOfLines={1} className={cn("flex-1 text-detail", headlineTones[headline.tone])}>
        {headline.text}
      </Text>
      {trailing}
    </View>
  );
}

/**
 * A root row's lines: the title, lighting up while its agent works, with its age at the end; the live headline; then
 * the facts line, only when there is something to say. A quiet row with nothing to say is the title line alone, its
 * mark at the line's end; otherwise the mark ends the line under the title. A parent keeps its facts line, where the
 * tree's line leaves for its sub threads.
 */
function RootLines({
  thread,
  project,
  headline,
  mark,
  working,
  parent,
  cloudLabel,
  onNode,
}: {
  thread: ThreadSummary;
  project: string | null;
  headline: ThreadHeadline | null;
  mark: ThreadMark | null;
  working: boolean;
  parent: boolean;
  cloudLabel: boolean;
  onNode: (mid: number) => void;
}) {
  const trailing = <RowMark thread={thread} mark={mark} />;
  const facts = rowLine(thread, project, cloudLabel);
  const factsLine = facts.words || facts.cloud || pullRequestMark(thread) || parent;
  const age = rowAge(latestActivity(thread), useSidebarNow());
  return (
    <>
      <ThreadRowHeading thread={thread} compact={false} mark={null} working={working} age={age} trailing={headline || factsLine ? null : trailing} />
      <HeadlineLine headline={headline} trailing={trailing} />
      {factsLine ? <FactsLine thread={thread} project={project} facts={facts} trailing={headline ? null : trailing} onNode={onNode} /> : null}
    </>
  );
}

/**
 * What a root row's facts line says: outside its project's group, the project's name; the teammate who started it,
 * unless the headline already speaks of who; and, for a thread of the Mac, its branch. `cloud` when it is an OpenOrc Cloud thread its label does
 * not already mark with the cloud.
 */
function rowLine(thread: ThreadSummary, project: string | null, cloudLabel: boolean): { words: string; cloud: boolean } {
  const inCloud = Boolean(placeOf(thread).rowIcon);
  const starter = togetherActivity(thread) ? null : rowStarter(thread)?.first;
  // A cloud thread's branch is the one OpenOrc Cloud made for it, which the cloud already says.
  const branch = inCloud ? null : thread.branch;
  return { words: [project, starter, branch].filter(Boolean).join(" · "), cloud: inCloud && !cloudLabel };
}

/** What a row says of its thread's state: a root row's pull request has its own place on the project line. */
function rowMarks(thread: ThreadSummary, compact: boolean) {
  const status = threadStatus(thread);
  const working = !compact && status?.kind === "running";
  return { status, working, mark: compact ? threadMark(thread) : status };
}

/**
 * A root row's facts line: a glyph at the margin, where the tree's line leaves for its sub threads (the cloud for an
 * OpenOrc Cloud thread, dimmed while it is out of reach, else the project's), the facts, then its pull request at the
 * end, in the state's own glyph and tone, with its number; the row's mark follows when no headline holds it.
 */
function FactsLine({
  thread,
  project,
  facts,
  trailing,
  onNode,
}: {
  thread: ThreadSummary;
  project: string | null;
  facts: { words: string; cloud: boolean };
  trailing: ReactNode;
  onNode: (mid: number) => void;
}) {
  const pull = pullRequestMark(thread);
  const cloud = cloudPlace(thread, project, useCloudOutOfReach());
  const Glyph = thread.projectId === WORKSPACE_ID ? Globe : Folder;
  const PullIcon = pull ? pullIcons[pull.state] : null;
  return (
    <View className="flex-row items-center gap-1.5" onLayout={(event) => onNode(event.nativeEvent.layout.y + event.nativeEvent.layout.height / 2)}>
      {cloud ? (
        // The glyph takes its ink from its class; its fade is the view's.
        <View className={cn(cloud.offline && "opacity-40")}>
          <Cloud size={16} className="text-ink-4" />
        </View>
      ) : (
        <Glyph size={16} className="text-ink-4" />
      )}
      <Text numberOfLines={1} className="flex-1 text-detail text-ink-4">
        {facts.words || (facts.cloud ? "OpenOrc Cloud" : "")}
      </Text>
      {pull && PullIcon ? (
        <View accessibilityLabel={pull.label} className="ml-auto flex-row items-center gap-1 pl-2">
          <PullIcon size={14} className={pullTones[pull.state]} />
          <Text className={cn("text-detail tabular-nums", pullTones[pull.state])}>#{pullRequestNumber(thread.prUrl)}</Text>
        </View>
      ) : null}
      {trailing}
    </View>
  );
}

/**
 * The desktop sidebar's thread row at touch size: the status lead, the title in ink, and a faint second line. That line is the
 * live headline while there is something to say (the step the agent is on, what it waits for, what a finished turn
 * came to), and otherwise where the thread works. The row holds the thread's live run, so the run's frames arrive.
 * Tapping it pushes the thread; holding it opens the thread's menu; swiping marks it read or unread, or archives it.
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
    cloudLabel,
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
    const [nodeMid, setNodeMid] = useState(NODE_MID);
    const cloud = cloudPlace(thread, project);
    const where = cloud?.spoken ?? [project, place.label].filter(Boolean).join(" · ");
    const facts = rowFacts(thread, where);
    const swipes = threadSwipes(thread);
    // A cloud thread is read here and changed on the Mac: its row has no swipe and no menu yet.
    const kept = isSubagentThread(thread) || cloud !== null;
    const leading: SwipeAction | undefined = kept ? undefined : { label: swipes.leading.label, tone: "review", run: () => actions.save(swipes.leading.patch) };
    const trailing: SwipeAction | undefined = swipes.trailing && !cloud ? { label: swipes.trailing.label, tone: "accent", run: () => actions.save(swipes.trailing!.patch) } : undefined;
    const pull = compact ? null : pullRequestMark(thread);
    const label = [thread.title, child ? subagentStatusLabel[child.status] : (mark ?? status)?.label, child?.agentType, compact ? null : headline?.text, pull?.label, ...facts]
      .filter(Boolean)
      .join(", ");
    const lines = compact ? (
      <ThreadRowHeading thread={thread} compact mark={mark} />
    ) : (
      <RootLines thread={thread} project={project} headline={headline} mark={mark} working={working} parent={Boolean(tree?.hasChildren)} cloudLabel={Boolean(cloudLabel)} onNode={setNodeMid} />
    );
    const node = compact ? undefined : { mid: nodeMid, reach: NODE_REACH };
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
              {cloud ? null : rowMenu(threadMenu(thread, "row", now), actions.run, { title: thread.title, subtitle: facts.join(" · ") })}
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
