import type { ProjectMeta } from "@openorc/client";
import { router } from "expo-router";
import { useContext, useState, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import { HostContext } from "../connection/host-context";
import { macAsleep } from "./out-of-reach";
import { ChevronDown, Folder, FolderOpen, Globe, Inbox, Plus } from "../generated/icons";
import type { IconProps } from "../ui/icon";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { useReducedMotion } from "../ui/reduced-motion";
import { turn } from "../ui/motion";
import { Text } from "../ui/Text";
import Animated from "react-native-reanimated";
import { movingStyle, STILL, type RowMotion } from "./fold-motion";
import type { HomeItem } from "./home-items";
import { TEXT_X, titleMid } from "./grid";
import { ThreadBranch, treeIndent } from "./ThreadBranch";

type Heading = Extract<HomeItem, { kind: "heading" }>;
type Section = Extract<HomeItem, { kind: "section" }>;

// The desktop's project-group-activity tones.
const metaTones: Record<ProjectMeta["tone"], string> = { attention: "text-warn", faint: "text-ink-4" };

const groupIcons: Record<Heading["group"], (open: boolean) => ComponentType<IconProps>> = {
  "needs-you": () => Inbox,
  workspace: () => Globe,
  project: (open) => (open ? FolderOpen : Folder),
};

/** The room above a heading: the most after rows end a section, none after a folded heading, so folds stack tight. */
export type HeadingRoom = "first" | "after-rows" | "after-heading";
const rooms: Record<HeadingRoom, string> = { first: "mt-3", "after-rows": "mt-4", "after-heading": "" };

function HeadingLine({ heading: { group, title, meta }, open }: { heading: Heading; open: boolean }) {
  const Icon = groupIcons[group](open);
  return (
    <>
      <View className="w-7 items-center">
        <Icon size={20} className="text-ink-4" />
      </View>
      <Text numberOfLines={1} className="flex-1 text-lg">
        {title}
      </Text>
      {meta ? <Text className={cn("text-detail tabular-nums", metaTones[meta.tone])}>{meta.text}</Text> : null}
    </>
  );
}

/**
 * A section heading like the sidebar's project heading, on Home's grid: a faint 20 pt glyph in the lead column, the
 * name in ink where row titles start, the meta in its tone ending where the plus begins. A project's heading folds it
 * on a tap, its folder glyph closing at once while its rows leave, and keeps its meta while folded; its own plus starts
 * a thread there, on the host the section lists, unless that is a Mac out of reach. Needs you never folds. Without a
 * plus the meta still ends at the action column, so every count lines up.
 */
export function HomeHeading({ heading, room = "after-rows", motion = STILL, onToggle }: { heading: Heading; room?: HeadingRoom; motion?: RowMotion; onToggle: () => void }) {
  const { projectId, title, meta } = heading;
  const open = heading.open && !motion.folding;
  const host = useContext(HostContext);
  const asleep = macAsleep(heading.owner);
  const label = [title, meta?.text].filter(Boolean).join(", ");
  if (!projectId) {
    return (
      <View accessible accessibilityRole="header" accessibilityLabel={label} className={cn("mx-3 min-h-touch flex-row items-center gap-3 pl-2 pr-12.5", rooms[room])}>
        <HeadingLine heading={heading} open={open} />
      </View>
    );
  }
  return (
    <View className={cn("mx-3 min-h-touch flex-row items-center", rooms[room])}>
      <ListPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        onPress={onToggle}
        className={cn("min-h-touch flex-1 flex-row items-center gap-3 rounded-lg pl-2 active:bg-surface-2", asleep && "mr-12.5")}
      >
        <HeadingLine heading={heading} open={open} />
      </ListPressable>
      {asleep ? null : (
        <ListPressable
          accessibilityRole="button"
          accessibilityLabel={`New thread in ${title}`}
          onPress={() => router.push({ pathname: "/new", params: host ? { projectId, host } : { projectId } })}
          className="mr-1.5 size-touch items-center justify-center rounded-full active:bg-surface-2"
        >
          <Plus size={20} className="text-ink-4" />
        </ListPressable>
      )}
    </View>
  );
}

/** A row the fold motion moves: rising in as its fold opens, fading as it closes. */
function Moving({ motion, children }: { motion: RowMotion; children: ReactNode }) {
  return <Animated.View style={movingStyle(motion, useReducedMotion())}>{children}</Animated.View>;
}

const sectionLabels: Record<Section["fold"], string> = { pinned: "Pinned", snoozed: "Snoozed" };

/**
 * A project's pinned or snoozed threads behind a quiet disclosure: the label and count where titles start, and the
 * chevron the sub threads use, in the action column, turning as the section opens.
 */
export function SectionToggle({ section, motion, onToggle }: { section: Section; motion: RowMotion; onToggle: () => void }) {
  const label = sectionLabels[section.fold];
  const open = section.open && !motion.folding;
  const still = useReducedMotion();
  return (
    <Moving motion={motion}>
      <ListPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}, ${section.count}`}
        onPress={onToggle}
        className="mx-3 min-h-touch flex-row items-center gap-1.5 rounded-lg pr-5 active:bg-surface-2"
        style={{ paddingLeft: TEXT_X - 12 }}
      >
        <Text className="text-detail text-ink-4">{label}</Text>
        <Text className="flex-1 text-detail text-ink-4 tabular-nums">{section.count}</Text>
        <Animated.View style={turn(open, still)}>
          <ChevronDown size={16} className="text-ink-4" />
        </Animated.View>
      </ListPressable>
    </Moving>
  );
}

/** The foot of a project that lists more threads than it shows: the next page, as the sidebar loads more. */
export function ShowMore({ project, motion, onPress }: { project: string; motion: RowMotion; onPress: () => void }) {
  return (
    <Moving motion={motion}>
      <ListPressable
        accessibilityRole="button"
        accessibilityLabel={`Show more in ${project}`}
        onPress={onPress}
        className="mx-3 min-h-touch justify-center rounded-lg active:bg-surface-2"
        style={{ paddingLeft: TEXT_X - 12 }}
      >
        <Text className="text-detail text-ink-4">Show more</Text>
      </ListPressable>
    </Moving>
  );
}

/** A parent's next page of sub threads, where their titles start, with the tree's trunks running past it. */
export function ShowMoreChildren({ item, motion, onPress }: { item: Extract<HomeItem, { kind: "children-more" }>; motion: RowMotion; onPress: () => void }) {
  const [height, setHeight] = useState(44);
  return (
    <Moving motion={motion}>
      <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
        <ListPressable
          accessibilityRole="button"
          accessibilityLabel={`Show ${item.count} more in ${item.tree.thread.title}`}
          onPress={onPress}
          style={{ paddingLeft: TEXT_X - 12 + treeIndent(item.tree.depth + 1) }}
          className="mx-3 min-h-touch justify-center rounded-lg active:bg-surface-2"
        >
          <Text className="text-detail text-ink-4">Show {item.count} more</Text>
        </ListPressable>
        <ThreadBranch row={item.tree} height={height} mid={titleMid(true, 1)} paging />
      </View>
    </Moving>
  );
}

/** A list the Mac could not give, as one faint row that asks again, where titles start. */
export function RetryRow({ projects, onPress }: { projects: boolean; onPress: () => void }) {
  return (
    <ListPressable
      accessibilityRole="button"
      onPress={onPress}
      className={cn("mx-3 min-h-touch justify-center rounded-lg active:bg-surface-2", projects && "mt-2")}
      style={{ paddingLeft: TEXT_X - 12 }}
    >
      <Text className="text-detail text-ink-4">{projects ? "Couldn’t load projects. Retry" : "Couldn’t load threads. Retry"}</Text>
    </ListPressable>
  );
}
