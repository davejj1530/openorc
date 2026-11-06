import {
  ownerMark,
  pullRequestMark,
  pullRequestNumber,
  relativeTime,
  subagentStatusLabel,
  threadHeadline,
  threadMark,
  threadPlace,
  threadStatus,
  workspaceLabel,
  type ThreadHeadline,
  type ThreadMark,
  type ThreadTreeRow,
} from "@openorc/client";
import { harnessShortName, isHarnessId, isSubagentThread, WORKSPACE_ID, type PrState, type ThreadSummary } from "@openorc/protocol";
import { Link } from "expo-router";
import { memo, useContext, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { HostContext } from "../connection/host-context";
import { Folder, GitMerge, GitPullRequest, GitPullRequestClosed, Globe } from "../generated/icons";
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
import { ACTION_INSET, ACTION_RESERVE, ROW_INSET } from "./grid";
import { ThreadTreeFrame, treeIndent, TreeToggle } from "./ThreadBranch";
import { leadReach, ThreadRowHeading } from "./ThreadRowHeading";
import { Spinner } from "./ThreadStatusMark";

const pullIcons: Record<PrState, ComponentType<IconProps>> = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed };
// The desktop's pull request tones.
const pullTones: Record<PrState, string> = { open: "text-ink-4", merged: "text-ok", closed: "text-bad" };
/** How far a project glyph reaches below its line's center, for the tree's line leaving it. */
const NODE_REACH = 6;
/** Where a root row's project line is centered before it lays out: the 8 pt padding, the title's 22 pt line, the 4 pt gap and half an 18 pt line. */
const NODE_MID = 8 + 22 + 4 + 9;
// The desktop's headline tones (ThreadHeadline.css).
const headlineTones: Record<ThreadHeadline["tone"], string> = { live: "text-ink-4", attention: "text-warn", done: "text-ink-4" };

/** Where it works, who works on it and when it last moved: the details a row keeps for its menu and for VoiceOver. */
function rowFacts(thread: ThreadSummary, where: string): string[] {
  return [where, isHarnessId(thread.agent) ? harnessShortName(thread.agent) : thread.agent, relativeTime(thread.lastActivityAt)];
}

/** The live headline under the title while there is something to say, in its tone. */
function HeadlineLine({ headline, onMid }: { headline: ThreadHeadline | null; onMid: (mid: number) => void }) {
  if (!headline) return null;
  return (
    <Text numberOfLines={1} className={cn("text-detail", headlineTones[headline.tone])} onLayout={(event) => onMid(event.nativeEvent.layout.y + event.nativeEvent.layout.height / 2)}>
      {headline.text}
    </Text>
  );
}

/** A working root row's spinner, in the action column on the line under its title: under a parent's chevron. */
function WorkingMark({ mid }: { mid: number }) {
  return (
    <View pointerEvents="none" className="absolute size-4 items-center justify-center" style={{ right: ACTION_INSET - ROW_INSET - 8, top: mid - 8 }}>
      <Spinner />
    </View>
  );
}

/**
 * A root row's lines: the title, lighting up while its agent works, with what it needs from you at the end; the live
 * headline; the project line. While it works, its spinner sits in the action column on the line under the title.
 */
function RootLines({
  thread,
  project,
  host,
  headline,
  mark,
  working,
  onNode,
}: {
  thread: ThreadSummary;
  project: string | null;
  host: string | null;
  headline: ThreadHeadline | null;
  mark: ThreadMark | null;
  working: boolean;
  onNode: (mid: number) => void;
}) {
  const [nodeMid, setNodeMid] = useState(NODE_MID);
  const [headlineMid, setHeadlineMid] = useState(NODE_MID);
  return (
    <>
      <ThreadRowHeading thread={thread} compact={false} mark={mark} working={working} />
      <HeadlineLine headline={headline} onMid={setHeadlineMid} />
      <ProjectLine
        thread={thread}
        project={project}
        host={host}
        onNode={(mid) => {
          setNodeMid(mid);
          onNode(mid);
        }}
      />
      {working ? <WorkingMark mid={headline ? headlineMid : nodeMid} /> : null}
    </>
  );
}

/** What a row says of its thread's state: a root row's pull request has its own place, and a working one's spinner sits under its title. */
function rowMarks(thread: ThreadSummary, compact: boolean, asleep: boolean) {
  const status = threadStatus(thread);
  const working = !compact && !asleep && status?.kind === "running";
  if (compact) return { status, working, mark: threadMark(thread) };
  return { status, working, mark: working ? null : status };
}

/**
 * A root row's last line: its project's glyph at the margin, where the tree's line leaves for its sub threads, the
 * project's name, where in it the thread works (and its host's state, while that is another), then its pull request
 * at the end, in the state's own glyph and tone, with its number.
 */
function ProjectLine({ thread, project, host, onNode }: { thread: ThreadSummary; project: string | null; host: string | null; onNode: (mid: number) => void }) {
  const pull = pullRequestMark(thread);
  const Glyph = thread.projectId === WORKSPACE_ID ? Globe : Folder;
  const PullIcon = pull ? pullIcons[pull.state] : null;
  return (
    <View className="flex-row items-center gap-1.5" onLayout={(event) => onNode(event.nativeEvent.layout.y + event.nativeEvent.layout.height / 2)}>
      <Glyph size={16} className="text-ink-4" />
      <Text numberOfLines={1} className="shrink text-detail text-ink-4">
        {/* The cloud is named as where it works; the host's other states follow it. */}
        {[project, workspaceLabel(thread), host === "Cloud" ? null : host].filter(Boolean).join(" · ")}
      </Text>
      {pull && PullIcon ? (
        <View accessibilityLabel={pull.label} className="ml-auto flex-row items-center gap-1 pl-2">
          <PullIcon size={14} className={pullTones[pull.state]} />
          <Text className={cn("text-detail tabular-nums", pullTones[pull.state])}>#{pullRequestNumber(thread.prUrl)}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A row of a Mac out of reach: dimmed, and a tap says why it does nothing. */
function AsleepRow({ label, className, style, indent, children }: { label: string; className: string; style: ViewStyle; indent: boolean; children: ReactNode }) {
  const [explained, setExplained] = useState(false);
  return (
    <ListPressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setExplained((shown) => !shown)} className={className} style={style}>
      <View className="gap-1 opacity-60">{children}</View>
      {explained ? <Text className={cn("mt-1 text-detail text-ink-3", indent && "ml-10")}>{MAC_ASLEEP}</Text> : null}
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
    const { status, working, mark } = rowMarks(thread, compact, asleep);
    const place = threadPlace(thread);
    const [nodeMid, setNodeMid] = useState(NODE_MID);
    const owner = ownerMark(thread);
    const host = useContext(HostContext);
    const where = [project, place.label, owner?.label].filter(Boolean).join(" · ");
    const facts = rowFacts(thread, where);
    const swipes = threadSwipes(thread);
    const leading: SwipeAction | undefined = isSubagentThread(thread) ? undefined : { label: swipes.leading.label, tone: "review", run: () => actions.save(swipes.leading.patch) };
    const trailing: SwipeAction | undefined = swipes.trailing ? { label: swipes.trailing.label, tone: "accent", run: () => actions.save(swipes.trailing!.patch) } : undefined;
    const pull = compact ? null : pullRequestMark(thread);
    const label = [thread.title, child ? subagentStatusLabel[child.status] : (mark ?? status)?.label, child?.agentType, compact ? null : headline?.text, pull?.label, ...facts]
      .filter(Boolean)
      .join(", ");
    const lines = compact ? (
      <ThreadRowHeading thread={thread} compact mark={mark} />
    ) : (
      <RootLines thread={thread} project={project} host={owner?.label ?? null} headline={headline} mark={mark} working={working} onNode={setNodeMid} />
    );
    const node = compact ? undefined : { mid: nodeMid, reach: NODE_REACH };
    const toggle = <TreeToggle tree={tree} open={open} compact={compact} onFold={onFold} />;
    if (asleep)
      return (
        <ThreadTreeFrame tree={tree} reach={leadReach(thread, mark)} node={node} motion={moves} compact={compact}>
          <AsleepRow label={label} className={rowClass} style={rowStyle} indent={compact}>
            {lines}
          </AsleepRow>
          {toggle}
        </ThreadTreeFrame>
      );
    return (
      <ThreadTreeFrame tree={tree} reach={leadReach(thread, mark)} node={node} motion={moves} compact={compact}>
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
