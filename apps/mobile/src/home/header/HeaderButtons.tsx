import { Link } from "expo-router";
import { Pressable, View } from "react-native";
import { endDemo } from "../../client";
import { Funnel, ListChecks, Pin, Settings } from "../../generated/icons";
import { useTaskBoard } from "../../tasks/use-task-board";
import { cn } from "../../ui/cn";
import { useColors } from "../../ui/mode";
import { OpenOrcMark } from "../../ui/OpenOrcMark";
import { Text } from "../../ui/Text";
import { FILTER_CHOICES, filterChoice, useHomeFilter } from "../filter";

/**
 * A header action, one of a family sized to the wordmark: a 40 pt circle on the plane fill with a 20 pt glyph, its fill
 * deepening while pressed; 44 pt to touch. Its center is the action column's, over the headings' pluses.
 */
const circle = "size-10 items-center justify-center rounded-full bg-surface active:bg-surface-3";
const reach = 2;

/** The filter's mark, as the sidebar's: orcmode and pins show their own, inked while the list is narrowed. */
export function FilterButton() {
  const choice = filterChoice(useHomeFilter());
  const colors = useColors();
  const narrowed = choice !== "active";
  const label = FILTER_CHOICES.find((item) => item.choice === choice)?.label;
  return (
    <Link href="/filter" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={narrowed ? `Show, ${label}` : "Show"} hitSlop={reach} className={circle}>
        {choice === "orc" ? <OpenOrcMark size={18} color={colors.ink} working={false} /> : null}
        {choice === "pinned" ? <Pin size={20} className="text-ink" /> : null}
        {choice === "active" || choice === "archived" ? <Funnel size={20} className={cn("text-ink-3", narrowed && "text-ink")} /> : null}
      </Pressable>
    </Link>
  );
}

/** The open tasks of this Mac and its cloud brain; shown once a host answers with its list, so never for one from before. */
function TasksButton() {
  if (!useTaskBoard().available) return null;
  return (
    <Link href="/tasks" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel="Tasks" hitSlop={reach} className={circle}>
        <ListChecks size={20} className="text-ink-3" />
      </Pressable>
    </Link>
  );
}

export function SettingsButton() {
  return (
    <Link href="/settings" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel="Settings" hitSlop={reach} className={circle}>
        <Settings size={20} className="text-ink-3" />
      </Pressable>
    </Link>
  );
}

/** Leaves the demo for pairing, where iOS puts Skip: a pill of the circles' height and fill. */
function SkipButton() {
  return (
    <Pressable accessibilityRole="button" onPress={endDemo} hitSlop={reach} className="h-10 justify-center rounded-full bg-surface px-4 active:bg-surface-3">
      <Text className="text-lg text-ink-2">Skip</Text>
    </Pressable>
  );
}

/** Which Mac the bar is for: none, a paired one, or the demo's. */
export type BarFor = "unpaired" | "paired" | "demo";

/**
 * Tasks once a host lists them, the filter, then Settings outermost, as circles 8 pt apart, Settings' over the plus
 * buttons on the list's project headings. With no Mac there is nothing to filter. In the demo Skip takes Settings'
 * place, which the Mac line still opens.
 */
export function HeaderButtons({ shows }: { shows: BarFor }) {
  return (
    <View className="flex-row gap-2">
      {shows === "paired" ? <TasksButton /> : null}
      {shows === "unpaired" ? null : <FilterButton />}
      {shows === "demo" ? <SkipButton /> : <SettingsButton />}
    </View>
  );
}
