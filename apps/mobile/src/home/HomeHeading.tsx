import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { ChevronDown } from "../generated/icons";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { useReducedMotion } from "../ui/reduced-motion";
import { turn } from "../ui/motion";
import { Text } from "../ui/Text";
import Animated from "react-native-reanimated";
import { movingStyle, type RowMotion } from "./fold-motion";
import type { HomeItem } from "./home-items";
import { MARGIN, ROW_INSET, TEXT_X, titleMid } from "./grid";
import { ThreadBranch, treeIndent } from "./ThreadBranch";

type Heading = Extract<HomeItem, { kind: "heading" }>;
type Section = Extract<HomeItem, { kind: "section" }>;

/** Where a root row's title starts, inside the row's inset: labels of the list's parts line up with it. */
const LABEL_PAD = MARGIN - ROW_INSET;

/** The room above a heading or part: the most after rows end one, none at the top past the bar's own. */
export type HeadingRoom = "first" | "after-rows" | "after-heading";
const rooms: Record<HeadingRoom, string> = { first: "mt-1", "after-rows": "mt-3", "after-heading": "" };

/**
 * Needs you's heading, in the form of the list's parts: its label where titles start, and how many wait in the
 * attention tone. It never folds, so it holds no chevron.
 */
export function HomeHeading({ heading, room = "after-rows" }: { heading: Heading; room?: HeadingRoom }) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${heading.title}, ${heading.count}`}
      className={cn("mx-3 min-h-touch flex-row items-center gap-1.5", rooms[room])}
      style={{ paddingLeft: LABEL_PAD }}
    >
      <Text className="text-detail text-ink-4">{heading.title}</Text>
      <Text className="text-detail text-warn tabular-nums">{heading.count}</Text>
    </View>
  );
}

/** A row the fold motion moves: rising in as its fold opens, fading as it closes. */
function Moving({ motion, children }: { motion: RowMotion; children: ReactNode }) {
  return <Animated.View style={movingStyle(motion, useReducedMotion())}>{children}</Animated.View>;
}

/**
 * A part of the list that folds: Pinned, a day, or Snoozed. Its label (and, for Pinned and Snoozed, its count) where
 * titles start, and the chevron the sub threads use in the action column, turning as the part opens.
 */
export function SectionToggle({ section, room = "after-rows", motion, onToggle }: { section: Section; room?: HeadingRoom; motion: RowMotion; onToggle: () => void }) {
  const open = section.open && !motion.folding;
  const still = useReducedMotion();
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={section.count === undefined ? section.label : `${section.label}, ${section.count}`}
      onPress={onToggle}
      className={cn("mx-3 min-h-touch flex-row items-center gap-1.5 rounded-lg pr-5 active:bg-surface-2", rooms[room])}
      style={{ paddingLeft: LABEL_PAD }}
    >
      <Text className="text-detail text-ink-4">{section.label}</Text>
      <Text className="flex-1 text-detail text-ink-4 tabular-nums">{section.count ?? ""}</Text>
      <Animated.View style={turn(open, still)}>
        <ChevronDown size={16} className="text-ink-4" />
      </Animated.View>
    </ListPressable>
  );
}

/** The foot of Older while the host has more threads to give: the next page, as the sidebar loads more. */
export function ShowMore({ motion, onPress }: { motion: RowMotion; onPress: () => void }) {
  return (
    <Moving motion={motion}>
      <ListPressable
        accessibilityRole="button"
        accessibilityLabel="Show more"
        onPress={onPress}
        className="mx-3 min-h-touch justify-center rounded-lg active:bg-surface-2"
        style={{ paddingLeft: LABEL_PAD }}
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

/** A list the host could not give, as one faint row that asks again, where titles start. */
export function RetryRow({ projects, onPress }: { projects: boolean; onPress: () => void }) {
  return (
    <ListPressable accessibilityRole="button" onPress={onPress} className={cn("mx-3 min-h-touch justify-center rounded-lg active:bg-surface-2", projects && "mt-2")} style={{ paddingLeft: LABEL_PAD }}>
      <Text className="text-detail text-ink-4">{projects ? "Couldn’t load projects. Retry" : "Couldn’t load threads. Retry"}</Text>
    </ListPressable>
  );
}
