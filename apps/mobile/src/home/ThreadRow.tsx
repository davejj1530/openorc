import { relativeTime, threadHeadline, threadMark, threadPlace, type ThreadHeadline, type ThreadPlace } from "@openorc/client";
import { harnessShortName, isHarnessId, type ThreadSummary } from "@openorc/protocol";
import { Link } from "expo-router";
import { memo, useMemo, type ComponentType } from "react";
import { View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { Folder, GitBranch, GitPullRequest } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { ListPressable } from "../ui/ListPressable";
import { arrive } from "../ui/motion";
import { swipeAccessibility, type SwipeAction } from "../ui/swipe";
import { SwipeRow } from "../ui/SwipeRow";
import { Text } from "../ui/Text";
import { markThreadOpening } from "../thread/perf-probe";
import { threadMenu, threadSwipes } from "../thread/thread-actions";
import { rowMenu } from "../thread/ThreadMenu";
import { useSnoozeClock } from "../thread/snooze-clock";
import { useThreadActions } from "../thread/use-thread-actions";
import { useRowRun } from "./row-run";
import { ThreadStatusMark } from "./ThreadStatusMark";

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
export const ThreadRow = memo(function ThreadRow({ thread, project, arriving }: { thread: ThreadSummary; project: string | null; arriving: boolean }) {
  const run = useRowRun(thread.liveRunId ?? undefined);
  const headline = useMemo(() => threadHeadline(thread, run), [thread, run]);
  const actions = useThreadActions(thread);
  const now = useSnoozeClock();
  const still = useReducedMotion();
  const mark = threadMark(thread);
  const place = threadPlace(thread);
  const PlaceIcon = placeIcons[place.kind];
  const where = project ? `${project} · ${place.label}` : place.label;
  const facts = rowFacts(thread, where);
  const swipes = threadSwipes(thread);
  const leading: SwipeAction = { label: swipes.leading.label, tone: "review", run: () => actions.save(swipes.leading.patch) };
  const trailing: SwipeAction | undefined = swipes.trailing ? { label: swipes.trailing.label, tone: "accent", run: () => actions.save(swipes.trailing!.patch) } : undefined;
  return (
    <Animated.View style={arriving && !still ? arrive : undefined}>
      <SwipeRow id={thread.id} leading={leading} trailing={trailing}>
        <Link href={{ pathname: "/thread/[id]", params: { id: thread.id } }} push dangerouslySingular asChild onPress={() => markThreadOpening(thread.id)}>
          <Link.Trigger>
            <ListPressable
              accessibilityRole="button"
              accessibilityLabel={[thread.title, mark?.label, headline?.text, ...facts].filter(Boolean).join(", ")}
              {...swipeAccessibility([leading, trailing])}
              className="mx-2.5 min-h-touch-row justify-center gap-0.5 rounded-md bg-bg px-2.5 py-1.5 active:bg-surface-2"
            >
              <View className="flex-row items-center gap-2">
                <ThreadStatusMark mark={mark} />
                <Text numberOfLines={1} className="flex-1 text-md leading-5 text-ink-3">
                  {thread.title}
                </Text>
              </View>
              <View className="ml-6 flex-row items-center gap-1">
                {headline ? null : <PlaceIcon size={12} className="text-ink-4" />}
                <Text numberOfLines={1} className={cn("flex-1 text-sm text-ink-4", headline && headlineTones[headline.tone])}>
                  {headline?.text ?? where}
                </Text>
              </View>
            </ListPressable>
          </Link.Trigger>
          {rowMenu(threadMenu(thread, "row", now), actions.run, { title: thread.title, subtitle: facts.join(" · ") })}
        </Link>
      </SwipeRow>
    </Animated.View>
  );
});
