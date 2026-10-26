import { Link } from "expo-router";
import { Pressable, View } from "react-native";
import { endDemo } from "../../client";
import { Funnel, Pin, Settings } from "../../generated/icons";
import { cn } from "../../ui/cn";
import { useColors } from "../../ui/mode";
import { OpenOrcMark } from "../../ui/OpenOrcMark";
import { Text } from "../../ui/Text";
import { FILTER_CHOICES, filterChoice, useHomeFilter } from "../filter";

/** The filter's mark, as the sidebar's: orcmode and pins show their own, inked while the list is narrowed. */
export function FilterButton() {
  const choice = filterChoice(useHomeFilter());
  const colors = useColors();
  const narrowed = choice !== "active";
  const label = FILTER_CHOICES.find((item) => item.choice === choice)?.label;
  return (
    <Link href="/filter" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={narrowed ? `Show, ${label}` : "Show"} className="size-touch items-center justify-center rounded-full active:bg-surface-2">
        {choice === "orc" ? <OpenOrcMark size={16} color={colors.ink} working={false} /> : null}
        {choice === "pinned" ? <Pin size={16} className="text-ink" /> : null}
        {choice === "active" || choice === "archived" ? <Funnel size={16} className={cn("text-ink-4", narrowed && "text-ink")} /> : null}
      </Pressable>
    </Link>
  );
}

export function SettingsButton() {
  return (
    <Link href="/settings" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel="Settings" className="size-touch items-center justify-center rounded-full active:bg-surface-2">
        <Settings size={16} className="text-ink-4" />
      </Pressable>
    </Link>
  );
}

/** Leaves the demo for pairing, where iOS puts Skip; its words end where the glyphs beside it are centered. */
function SkipButton() {
  return (
    <Pressable accessibilityRole="button" onPress={endDemo} className="min-h-touch justify-center rounded-full px-2.5 active:bg-surface-2">
      <Text className="text-md text-ink-2">Skip</Text>
    </Pressable>
  );
}

/** Which Mac the bar is for: none, a paired one, or the demo's. */
export type BarFor = "unpaired" | "paired" | "demo";

/**
 * The filter, then Settings outermost, as two 44 pt buttons whose glyphs line up with the plus buttons on the list's
 * project headings. With no Mac there is nothing to filter. In the demo Skip takes Settings' place, which the Mac line
 * still opens.
 */
export function HeaderButtons({ shows }: { shows: BarFor }) {
  return (
    <View className="-mr-2.5 flex-row">
      {shows === "unpaired" ? null : <FilterButton />}
      {shows === "demo" ? <SkipButton /> : <SettingsButton />}
    </View>
  );
}
