import { ownerMark, relativeTime, subagentStatusLabel, threadHeadline, threadMark, threadPlace, type ThreadHeadline, type ThreadPlace, type ThreadTreeRow } from "@openorc/client";
import { harnessShortName, isHarnessId, isSubagentThread, type ThreadSummary } from "@openorc/protocol";
import { Link } from "expo-router";
import { memo, useContext, useMemo, type ComponentType } from "react";
import { View } from "react-native";
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
import { ThreadTreeFrame } from "./ThreadBranch";
import { ThreadRowHeading } from "./ThreadRowHeading";

const placeIcons: Record<ThreadPlace["kind"], ComponentType<IconProps>> = { branch: GitBranch, pull: GitPullRequest, folder: Folder };
// The desktop's headline tones (ThreadHeadline.css).
const headlineTones: Record<ThreadHeadline["tone"], string> = { live: "text-ink-3", attention: "text-warn", done: "text-ink-4" };

/** Where it works, who works on it and when it last moved: the details a row keeps for its menu and for VoiceOver. */
function rowFacts(thread: ThreadSummary, where: string): string[] {
  return [where, isHarnessId(thread.agent) ? harnessShortName(thread.agent) : thread.agent, relativeTime(thread.lastActivityAt)];
}

/**
 * The desktop sidebar's thread row at touch size: the status lead, the muted title, and a second line. That line is the
 * live headline while there is something to say (the step the agent is on, what it waits for, what a finished turn
 * came to), and otherwise where the thread works. The row holds the thread's live run, so the run's frames arrive.
 * Tapping it pushes the thread; holding it opens the thread's menu; swiping marks it read or unread, or archives it.
 */
export const ThreadRow = memo(function ThreadRow({
  thread,
  project,
  arriving,
  tree,
  onToggle,
}: {
  thread: ThreadSummary;
  project: string | null;
  arriving: boolean;
  tree?: ThreadTreeRow;
  onToggle?: () => void;
}) {
  const run = useRowRun(thread.liveRunId ?? undefined);
  const headline = useMemo(() => threadHeadline(thread, run), [thread, run]);
  const actions = useThreadActions(thread);
  const now = useSnoozeClock();
  const compact = Boolean(tree?.depth);
  const child = thread.subagent;
  const mark = threadMark(thread);
  const place = threadPlace(thread);
  const PlaceIcon = placeIcons[place.kind];
  const owner = ownerMark(thread);
  const host = useContext(HostContext);
  const where = [project, place.label, owner?.label].filter(Boolean).join(" · ");
  const facts = rowFacts(thread, where);
  const swipes = threadSwipes(thread);
  const leading: SwipeAction | undefined = isSubagentThread(thread) ? undefined : { label: swipes.leading.label, tone: "review", run: () => actions.save(swipes.leading.patch) };
  const trailing: SwipeAction | undefined = swipes.trailing ? { label: swipes.trailing.label, tone: "accent", run: () => actions.save(swipes.trailing!.patch) } : undefined;
  return (
    <ThreadTreeFrame tree={tree} arriving={arriving} onToggle={onToggle}>
      <SwipeRow id={thread.id} leading={leading} trailing={trailing}>
        <Link href={{ pathname: "/thread/[id]", params: host ? { id: thread.id, host } : { id: thread.id } }} push dangerouslySingular asChild onPress={() => markThreadOpening(thread.id)}>
          <Link.Trigger>
            <ListPressable
              accessibilityRole="button"
              accessibilityLabel={[thread.title, child ? subagentStatusLabel[child.status] : mark?.label, compact ? null : headline?.text, ...facts].filter(Boolean).join(", ")}
              {...swipeAccessibility([leading, trailing])}
              className={cn("mx-2.5 justify-center gap-0.5 rounded-md bg-bg px-2.5 py-1.5 active:bg-surface-2", compact ? "min-h-touch" : "min-h-touch-row", owner?.dim && "opacity-60")}
            >
              <ThreadRowHeading thread={thread} compact={compact} mark={mark} />
              {!compact ? (
                <View className="ml-6 flex-row items-center gap-1">
                  {headline ? null : <PlaceIcon size={12} className="text-ink-4" />}
                  <Text numberOfLines={1} className={cn("flex-1 text-sm text-ink-4", headline && headlineTones[headline.tone])}>
                    {headline?.text ?? where}
                  </Text>
                </View>
              ) : null}
            </ListPressable>
          </Link.Trigger>
          {rowMenu(threadMenu(thread, "row", now), actions.run, { title: thread.title, subtitle: facts.join(" · ") })}
        </Link>
      </SwipeRow>
    </ThreadTreeFrame>
  );
});
