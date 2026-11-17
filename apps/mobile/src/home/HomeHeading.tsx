import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { AlarmClock, ChevronDown, CircleCheck, Cloud, Folder, Globe, Pin } from "../generated/icons";
import { WORKSPACE_ID } from "@openorc/protocol";
import type { ComponentType } from "react";
import type { IconProps } from "../ui/icon";
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

type Section = Extract<HomeItem, { kind: "section" }>;
type Group = Extract<HomeItem, { kind: "project" }>;

/** Where a root row's title starts, inside the row's inset: labels of the list's parts line up with it. */
const LABEL_PAD = MARGIN - ROW_INSET;

/** The room above a heading or part: the most after rows end one, none at the top past the bar's own. */
export type HeadingRoom = "first" | "after-rows" | "after-heading";
const rooms: Record<HeadingRoom, string> = { first: "mt-1", "after-rows": "mt-3", "after-heading": "" };

/** A row the fold motion moves: rising in as its fold opens, fading as it closes. */
function Moving({ motion, children }: { motion: RowMotion; children: ReactNode }) {
  return <Animated.View style={movingStyle(motion, useReducedMotion())}>{children}</Animated.View>;
}

const partMarks: Record<Section["part"], ComponentType<IconProps>> = { pinned: Pin, snoozed: AlarmClock, resolved: CircleCheck };

/**
 * A label that folds what is under it, in one shape for every part of the list, as the desktop's sidebar heads its
 * groups: a mark where the rows' titles start, the words, what it counts, the chevron after them turning as it folds,
 * and at the end an amber count of what waits on the person.
 */
function FoldLabel({
  mark: Mark,
  words,
  spoken,
  count,
  waiting = 0,
  open,
  room,
  onToggle,
}: {
  mark: ComponentType<IconProps>;
  words: string;
  spoken: string;
  count?: number;
  waiting?: number;
  open: boolean;
  room: HeadingRoom;
  onToggle: () => void;
}) {
  const still = useReducedMotion();
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={spoken}
      onPress={onToggle}
      className={cn("mx-3 min-h-touch flex-row items-center gap-2 rounded-lg pr-5 active:bg-surface-2", rooms[room])}
      style={{ paddingLeft: LABEL_PAD }}
    >
      <Mark size={16} className="text-ink-3" />
      <Text numberOfLines={1} className="shrink text-detail text-ink-3">
        {words}
      </Text>
      {count === undefined ? null : <Text className="text-detail tabular-nums text-ink-4">{count}</Text>}
      <Animated.View style={turn(open, still)}>
        <ChevronDown size={14} className="text-ink-4" />
      </Animated.View>
      <View className="flex-1" />
      {waiting ? <Text className="text-detail tabular-nums text-warn">{waiting}</Text> : null}
    </ListPressable>
  );
}

/** Pinned, Snoozed or Resolved: its mark, its label and, for Pinned and Snoozed, how many it holds. */
export function SectionToggle({ section, room = "after-rows", motion, onToggle }: { section: Section; room?: HeadingRoom; motion: RowMotion; onToggle: () => void }) {
  return (
    <FoldLabel
      mark={partMarks[section.part]}
      words={section.label}
      spoken={section.count === undefined ? section.label : `${section.label}, ${section.count}`}
      count={section.count}
      open={section.open && !motion.folding}
      room={room}
      onToggle={onToggle}
    />
  );
}

/** A project's mark: the cloud for one only OpenOrc Cloud has, the globe for No project, else a folder. */
export function projectMark(project: { id: string; cloud?: true }): ComponentType<IconProps> {
  if (project.cloud) return Cloud;
  return project.id === WORKSPACE_ID ? Globe : Folder;
}

/** A project's label over its threads: its mark (a folder, or the cloud for a project only OpenOrc Cloud has), its name, and what in it waits on the person. */
export function ProjectLabel({ group, room = "after-rows", motion, onToggle }: { group: Group; room?: HeadingRoom; motion: RowMotion; onToggle: () => void }) {
  const mark = projectMark(group.project);
  return (
    <FoldLabel
      mark={mark}
      words={group.project.name}
      spoken={group.waiting ? `${group.project.name}, ${group.waiting} need you` : group.project.name}
      waiting={group.waiting}
      open={group.open && !motion.folding}
      room={room}
      onToggle={onToggle}
    />
  );
}

/** The foot of a project's group while it holds more: the next ten, where titles start. */
export function ShowMoreInGroup({ count, motion, onPress }: { count: number; motion: RowMotion; onPress: () => void }) {
  return (
    <Moving motion={motion}>
      <ListPressable accessibilityRole="button" onPress={onPress} className="mx-3 min-h-touch justify-center rounded-lg active:bg-surface-2" style={{ paddingLeft: LABEL_PAD }}>
        <Text className="text-detail text-ink-4">Show {count} more</Text>
      </ListPressable>
    </Moving>
  );
}

/** The foot of Resolved, or of Pinned under the pinned filter, while the host has more threads to give: the next page. */
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

/** A space whose only project holds no threads yet: the quiet words the app's empty lists use, under its label. */
export function NoThreadsYet() {
  return (
    <View className="items-center px-8 pt-24">
      <Text className="text-lg text-ink-2">No threads yet</Text>
    </View>
  );
}
