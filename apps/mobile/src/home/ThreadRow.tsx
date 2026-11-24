import {
  MENTION_MARK,
  mentionLeads,
  pullRequestMark,
  relativeTime,
  rowFacts,
  rowStarter,
  subagentStatusLabel,
  togetherActivity,
  threadHeadline,
  threadMark,
  threadPlace,
  threadStateMark,
  threadStatus,
  type ThreadMark,
  type ThreadMarkKind,
  type ThreadTreeRow,
  useSidebarNow,
} from "@openorc/client";
import { harnessShortName, isHarnessId, isSubagentThread, placeOf, type ThreadSummary } from "@openorc/protocol";
import { Link, router, type Href } from "expo-router";
import { memo, useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { Cloud } from "../generated/icons";
import { useListOpen, useSplit } from "../layout";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { PersonFace } from "../ui/PersonFace";
import { swipeAccessibility, type SwipeAction } from "../ui/swipe";
import { SwipeRow } from "../ui/SwipeRow";
import { SweepText } from "../ui/SweepText";
import { useCloudOutOfReach } from "../spaces/cloud-reach";
import { markThreadOpening } from "../thread/perf-probe";
import { threadMenu, threadSwipes } from "../thread/thread-actions";
import { rowMenu } from "../thread/ThreadMenu";
import { useSnoozeClock } from "../thread/snooze-clock";
import { useThreadActions } from "../thread/use-thread-actions";
import { useRowRun } from "./row-run";
import { STILL, type RowMotion } from "./fold-motion";
import { CHROME_SCALE, MARGIN, ROOT_GAP, ROW_INSET, titleMid } from "./grid";
import { ThreadTreeFrame, treeIndent, TreeToggle } from "./ThreadBranch";
import { DISCLOSURE_AT, leadReach, RowStatus, RowTitle, ThreadRowHeading } from "./ThreadRowHeading";

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

/** A row's padding either side, inside its pressed fill: its lead starts and its facts end at the margin. */
const ROW_PAD = MARGIN - ROW_INSET;

/**
 * A root row's facts, as the desktop's row packs them at its end: who started it when it is someone else, and the cloud
 * for an OpenOrc Cloud thread whose group's label does not wear it, dimmed while out of reach. Each sits in a 16 pt
 * slot; absent facts leave their room to the title. What they say is in the row's label.
 */
function FactSlots({ thread, cloudLabel }: { thread: ThreadSummary; cloudLabel: boolean }) {
  const starter = rowStarter(thread);
  const place = cloudPlace(thread, null, useCloudOutOfReach());
  // Under a group whose label wears the cloud, the label says it, and dims for its rows while out of reach.
  const cloud = cloudLabel ? null : place;
  if (!starter && !cloud) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {starter ? (
        <View className="size-4 items-center justify-center">
          <PersonFace name={starter.name} image={starter.image} size="sm" />
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

/** What a row's cube needs: its mark, and the work its live run names. */
type Lead = { mark: ThreadMark | null; kind: ThreadMarkKind | undefined };

/**
 * A root row's one line, as the desktop sidebar's: its cube in one column down the list, the title, lighting up while
 * its agent works, a parent's disclosure after it, then its facts at the end. When it last moved, where it works and
 * what it is doing are in its label and its menu.
 */
function RootLine({
  thread,
  lead,
  working,
  parent,
  cloudLabel,
  onTitleEnd,
}: {
  thread: ThreadSummary;
  lead: Lead;
  working: boolean;
  parent: boolean;
  cloudLabel: boolean;
  onTitleEnd: (x: number) => void;
}) {
  return (
    <View className="flex-row items-center" style={{ gap: ROOT_GAP }}>
      <RowStatus thread={thread} mark={lead.mark} kind={lead.kind} className="w-5" />
      <RowTitle parent={parent} onEnd={onTitleEnd}>
        <SweepText text={thread.title} className="text-xl text-ink" sweeping={working} />
      </RowTitle>
      <FactSlots thread={thread} cloudLabel={cloudLabel} />
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

/** What a row says of its thread's state: its status, or its pull request while it rests. */
function rowMarks(thread: ThreadSummary, compact: boolean) {
  const status = threadStatus(thread);
  const working = !compact && status?.kind === "running";
  // The reader's unread mention stands before a quiet wait or an unread result, as on the desktop.
  if (mentionLeads(thread, status)) return { status, working, mark: MENTION_MARK };
  return { status, working, mark: threadMark(thread) };
}

/**
 * The desktop sidebar's thread row at touch size: one line, the title in ink and the row's facts, age and mark at its
 * end. The row holds the thread's live run, so the run's frames arrive and its label says what the agent is on.
 * Tapping it pushes the thread; holding it opens the thread's menu; swiping marks it read or unread, or archives it.
 */
/** How a row sits in its project's tree: its padding, its disclosure's state and how it moves. One height for every row. */
function treePlace(tree: ThreadTreeRow | undefined, motion: RowMotion, arriving: boolean, lit: boolean) {
  const compact = Boolean(tree?.depth);
  return {
    compact,
    rowClass: cn("mx-3 min-h-touch justify-center rounded-lg px-2 active:bg-surface-2", lit ? "bg-navigation-soft" : "bg-bg", compact ? "py-2.75" : "py-2.5"),
    rowStyle: { paddingLeft: ROW_PAD + treeIndent(tree?.depth ?? 0), paddingRight: ROW_PAD },
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
    shown = false,
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
    /** Its thread is the one open. Its row is lit where the window shows the list beside it. */
    shown?: boolean;
  }) {
    const run = useRowRun(thread.liveRunId ?? undefined);
    const href = useMemo<Href>(() => ({ pathname: "/thread/[id]", params: { id: thread.id } }), [thread.id]);
    // In a cloud thread someone else is in, whose turn or ask it is says more than "Working", as the thread's header does.
    const headline = useMemo(() => togetherActivity(thread) ?? threadHeadline(thread, run), [thread, run]);
    const actions = useThreadActions(thread);
    const now = useSnoozeClock();
    const split = useSplit();
    const openBeside = useListOpen();
    const { compact, rowClass, rowStyle, open, moves } = treePlace(tree, motion, arriving, split && shown);
    const child = thread.subagent;
    const { status, working, mark } = rowMarks(thread, compact);
    const lead: Lead = { mark, kind: threadStateMark(thread, { run })?.kind };
    const parent = Boolean(tree?.hasChildren && onFold);
    // Where the title ends on its line, for a parent's disclosure to follow it.
    const [titleEnd, setTitleEnd] = useState<number | null>(null);
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
        : { state: mark?.label, about: [headline?.text, detail, pullRequestMark(thread)?.label] },
      facts,
    );
    const lines = compact ? (
      <ThreadRowHeading thread={thread} mark={mark} kind={lead.kind} parent={parent} onTitleEnd={setTitleEnd} />
    ) : (
      <RootLine thread={thread} lead={lead} working={working} parent={parent} cloudLabel={cloudLabel} onTitleEnd={setTitleEnd} />
    );
    // A root row's own tree line drops from under its title's first letters.
    const node = compact ? undefined : { mid: titleMid(false, fontScale) + 12 * Math.min(fontScale, CHROME_SCALE), reach: 0 };
    const toggle = <TreeToggle tree={tree} open={open} compact={compact} at={titleEnd === null ? null : ROW_INSET + rowStyle.paddingLeft + titleEnd + DISCLOSURE_AT} onFold={onFold} />;
    return (
      <ThreadTreeFrame tree={tree} reach={leadReach(thread, mark)} node={node} motion={moves} compact={compact}>
        <SwipeRow id={thread.id} leading={leading} trailing={trailing}>
          <View>
            <Link
              href={href}
              push
              dangerouslySingular
              asChild
              onPress={(event) => {
                markThreadOpening(thread.id);
                if (!split) return;
                // Beside the list the thread takes the place of what was open; its own row brings it back from under a panel.
                event.preventDefault();
                if (shown) router.dismissTo(href);
                else openBeside(href);
              }}
            >
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
    before.shown === next.shown &&
    sameTree(before.tree, next.tree),
);
