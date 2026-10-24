import type { ProjectMeta } from "@openorc/client";
import { router } from "expo-router";
import type { ComponentType } from "react";
import { Pressable, View } from "react-native";
import { Folder, FolderOpen, Globe, Inbox, Plus } from "../generated/icons";
import type { IconProps } from "../ui/icon";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import type { HomeItem } from "./home-items";

type Heading = Extract<HomeItem, { kind: "heading" }>;

// The desktop's project-group-activity tones.
const metaTones: Record<ProjectMeta["tone"], string> = { attention: "text-warn", faint: "text-ink-4" };

const groupIcons: Record<Heading["group"], (open: boolean) => ComponentType<IconProps>> = {
  "needs-you": () => Inbox,
  workspace: () => Globe,
  project: (open) => (open ? FolderOpen : Folder),
};

/**
 * A section heading like the sidebar's project heading: a faint 16 pt glyph, the name in ink, the meta in its tone, and
 * for a project the plus that starts a thread there. The sidebar shows its plus on hover, and always where there is no
 * hover; a phone has none.
 */
export function HomeHeading({ heading: { group, projectId, title, meta, open } }: { heading: Heading }) {
  const Icon = groupIcons[group](open);
  return (
    <View className="mx-2.5 mt-4 h-control-row flex-row items-center gap-1 pl-1.5">
      <View className="mx-1">
        <Icon size={16} className="text-ink-4" />
      </View>
      <Text accessibilityRole="header" numberOfLines={1} className="flex-1 leading-4">
        {title}
      </Text>
      {meta ? <Text className={cn("pr-1.25 text-sm leading-4", metaTones[meta.tone])}>{meta.text}</Text> : null}
      {projectId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New thread in ${title}`}
          onPress={() => router.push({ pathname: "/new", params: { projectId } })}
          hitSlop={8}
          className="size-7 items-center justify-center rounded-full active:bg-surface-2"
        >
          <Plus size={16} className="text-ink-4" />
        </Pressable>
      ) : (
        <View className="w-1.25" />
      )}
    </View>
  );
}

/** The foot of a project that lists more threads than it shows: the next page, as the sidebar loads more. */
export function ShowMore({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} className="mx-2.5 h-touch justify-center rounded-md pl-8.5 active:bg-surface-2">
      <Text className="text-sm text-ink-4">Show more</Text>
    </Pressable>
  );
}

/** The quiet label over a project's pinned threads. */
export function PinnedLabel({ count }: { count: number }) {
  return (
    <View className="mx-2.5 h-7 flex-row items-center gap-1.5 pl-8.5">
      <Text className="text-sm text-ink-4">Pinned</Text>
      <Text className="text-sm text-ink-4">{count}</Text>
    </View>
  );
}
