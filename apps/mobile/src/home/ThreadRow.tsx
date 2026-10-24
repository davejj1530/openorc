import { threadHeadline, threadMark, threadPlace, type ThreadHeadline, type ThreadPlace } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { memo, useMemo, type ComponentType } from "react";
import { Pressable, View } from "react-native";
import { useRun } from "../client";
import { Folder, GitBranch, GitPullRequest } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { Text } from "../ui/Text";
import { ThreadStatusMark } from "./ThreadStatusMark";

const placeIcons: Record<ThreadPlace["kind"], ComponentType<IconProps>> = { branch: GitBranch, pull: GitPullRequest, folder: Folder };
// The desktop's headline tones (ThreadHeadline.css).
const headlineTones: Record<ThreadHeadline["tone"], string> = { live: "text-ink-3", attention: "text-warn", done: "text-ink-4" };

/**
 * The desktop sidebar's thread row at touch size: the status lead, the muted title, and a second line. That line is the
 * live headline while there is something to say (the step the agent is on, what it waits for, what a finished turn
 * came to), and otherwise where the thread works. The row holds the thread's live run, so the run's frames arrive.
 */
export const ThreadRow = memo(function ThreadRow({ thread, project }: { thread: ThreadSummary; project: string | null }) {
  const run = useRun(thread.liveRunId ?? undefined);
  const headline = useMemo(() => threadHeadline(thread, run), [thread, run]);
  const mark = threadMark(thread);
  const place = threadPlace(thread);
  const PlaceIcon = placeIcons[place.kind];
  const where = project ? `${project} · ${place.label}` : place.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[thread.title, mark?.label, headline?.text ?? where].filter(Boolean).join(", ")}
      className="mx-2.5 h-touch-row justify-center gap-0.5 rounded-md px-2.5 active:bg-surface-2"
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
    </Pressable>
  );
});
