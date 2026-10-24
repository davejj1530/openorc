import type { ThreadSummary } from "@openorc/protocol";
import { memo, type ComponentType } from "react";
import { Pressable, View } from "react-native";
import { Folder, GitBranch, GitPullRequest } from "../generated/icons";
import type { IconProps } from "../ui/icon";
import { Text } from "../ui/Text";
import { ThreadStatusMark } from "./ThreadStatusMark";
import { threadMark, threadPlace, type ThreadPlace } from "./thread-row-model";

const placeIcons: Record<ThreadPlace["kind"], ComponentType<IconProps>> = { branch: GitBranch, pull: GitPullRequest, folder: Folder };

/**
 * The desktop sidebar's thread row at touch size: the status lead, the muted title, and a faint second line with where
 * the thread works. The live headline joins the second line once the phone reads runs from the Mac.
 */
export const ThreadRow = memo(function ThreadRow({ thread, project }: { thread: ThreadSummary; project: string | null }) {
  const mark = threadMark(thread);
  const place = threadPlace(thread);
  const PlaceIcon = placeIcons[place.kind];
  const where = project ? `${project} · ${place.label}` : place.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[thread.title, mark?.label, where].filter(Boolean).join(", ")}
      className="mx-2.5 h-touch-row justify-center gap-0.5 rounded-md px-2.5 active:bg-surface-2"
    >
      <View className="flex-row items-center gap-2">
        <ThreadStatusMark mark={mark} />
        <Text numberOfLines={1} className="flex-1 text-md leading-5 text-ink-3">
          {thread.title}
        </Text>
      </View>
      <View className="ml-6 flex-row items-center gap-1">
        <PlaceIcon size={12} className="text-ink-4" />
        <Text numberOfLines={1} className="flex-1 text-sm text-ink-4">
          {where}
        </Text>
      </View>
    </Pressable>
  );
});
