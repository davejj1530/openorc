import type { ComponentType } from "react";
import { View } from "react-native";
import { Folder, FolderOpen, Globe, Inbox } from "../generated/icons";
import type { IconProps } from "../ui/icon";
import { Text } from "../ui/Text";
import type { HomeItem } from "./home-items";

type Heading = Extract<HomeItem, { kind: "heading" }>;

const groupIcons: Record<Heading["group"], (open: boolean) => ComponentType<IconProps>> = {
  "needs-you": () => Inbox,
  workspace: () => Globe,
  project: (open) => (open ? FolderOpen : Folder),
};

/** A section heading like the sidebar's project heading: a faint 16 pt glyph, the name in ink, a faint meta. */
export function HomeHeading({ heading: { group, title, meta, open } }: { heading: Heading }) {
  const Icon = groupIcons[group](open);
  return (
    <View accessibilityRole="header" className="mx-2.5 mt-4 h-control-row flex-row items-center gap-1 pl-1.5 pr-1.25">
      <View className="mx-1">
        <Icon size={16} className="text-ink-4" />
      </View>
      <Text numberOfLines={1} className="flex-1 leading-4">
        {title}
      </Text>
      <Text className="pr-1.25 text-sm leading-4 text-ink-4">{meta}</Text>
    </View>
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
