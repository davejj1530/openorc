import type { ProjectMeta } from "@openorc/client";
import { router } from "expo-router";
import type { ComponentType } from "react";
import { View } from "react-native";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Globe, Inbox, Plus } from "../generated/icons";
import type { IconProps } from "../ui/icon";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { Text } from "../ui/Text";
import type { HomeItem } from "./home-items";

type Heading = Extract<HomeItem, { kind: "heading" }>;
type Section = Extract<HomeItem, { kind: "section" }>;

// The desktop's project-group-activity tones.
const metaTones: Record<ProjectMeta["tone"], string> = { attention: "text-warn", faint: "text-ink-4" };

const groupIcons: Record<Heading["group"], (open: boolean) => ComponentType<IconProps>> = {
  "needs-you": () => Inbox,
  workspace: () => Globe,
  project: (open) => (open ? FolderOpen : Folder),
};

function HeadingLine({ heading: { group, title, meta, open } }: { heading: Heading }) {
  const Icon = groupIcons[group](open);
  return (
    <>
      <View className="mx-1">
        <Icon size={16} className="text-ink-4" />
      </View>
      <Text numberOfLines={1} className="flex-1 leading-4">
        {title}
      </Text>
      {meta ? <Text className={cn("pr-1.25 text-sm leading-4", metaTones[meta.tone])}>{meta.text}</Text> : null}
    </>
  );
}

/**
 * A section heading like the sidebar's project heading: a faint 16 pt glyph, the name in ink, the meta in its tone. A
 * project's heading folds it on a tap, its folder glyph closing, and keeps its meta while folded; its own plus beside
 * it starts a thread there. Needs you never folds.
 */
export function HomeHeading({ heading, onToggle }: { heading: Heading; onToggle: () => void }) {
  const { projectId, title, meta, open } = heading;
  if (!projectId) {
    return (
      <View accessible accessibilityRole="header" accessibilityLabel={[title, meta?.text].filter(Boolean).join(", ")} className="mx-2.5 mt-3 min-h-touch flex-row items-center gap-1 pl-1.5 pr-3">
        <HeadingLine heading={heading} />
      </View>
    );
  }
  return (
    <View className="mx-2.5 mt-3 min-h-touch flex-row items-center">
      <ListPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[title, meta?.text].filter(Boolean).join(", ")}
        onPress={onToggle}
        className="min-h-touch flex-1 flex-row items-center gap-1 rounded-md pl-1.5 active:bg-surface-2"
      >
        <HeadingLine heading={heading} />
      </ListPressable>
      <ListPressable
        accessibilityRole="button"
        accessibilityLabel={`New thread in ${title}`}
        onPress={() => router.push({ pathname: "/new", params: { projectId } })}
        className="size-touch items-center justify-center rounded-full active:bg-surface-2"
      >
        <Plus size={16} className="text-ink-4" />
      </ListPressable>
    </View>
  );
}

const sectionLabels: Record<Section["fold"], string> = { pinned: "Pinned", snoozed: "Snoozed" };

/** A project's pinned or snoozed threads behind a quiet disclosure, with the desktop's 12 pt chevron and the count. */
export function SectionToggle({ section, onToggle }: { section: Section; onToggle: () => void }) {
  const label = sectionLabels[section.fold];
  const Chevron = section.open ? ChevronDown : ChevronRight;
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityState={{ expanded: section.open }}
      accessibilityLabel={`${label}, ${section.count}`}
      onPress={onToggle}
      className="mx-2.5 min-h-touch flex-row items-center gap-1.5 rounded-md pl-8.5 active:bg-surface-2"
    >
      <Chevron size={12} className="text-ink-4" />
      <Text className="text-sm text-ink-4">{label}</Text>
      <Text className="text-sm text-ink-4 tabular-nums">{section.count}</Text>
    </ListPressable>
  );
}

/** The foot of a project that lists more threads than it shows: the next page, as the sidebar loads more. */
export function ShowMore({ project, onPress }: { project: string; onPress: () => void }) {
  return (
    <ListPressable accessibilityRole="button" accessibilityLabel={`Show more in ${project}`} onPress={onPress} className="mx-2.5 min-h-touch justify-center rounded-md pl-8.5 active:bg-surface-2">
      <Text className="text-sm text-ink-4">Show more</Text>
    </ListPressable>
  );
}

/** A list the Mac could not give, as one faint row that asks again. */
export function RetryRow({ projects, onPress }: { projects: boolean; onPress: () => void }) {
  return (
    <ListPressable accessibilityRole="button" onPress={onPress} className={cn("mx-2.5 min-h-touch justify-center rounded-md active:bg-surface-2", projects ? "mt-2 pl-3" : "pl-8.5")}>
      <Text className="text-sm text-ink-4">{projects ? "Couldn’t load projects. Retry" : "Couldn’t load threads. Retry"}</Text>
    </ListPressable>
  );
}
