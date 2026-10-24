import { Link } from "expo-router";
import { Pressable, View } from "react-native";
import { Funnel, Pin, Settings } from "../../generated/icons";
import { cn } from "../../ui/cn";
import { useColors } from "../../ui/mode";
import { OpenOrcMark } from "../../ui/OpenOrcMark";
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

/**
 * The filter, then Settings outermost, as two 44 pt buttons whose glyphs line up with the plus buttons on the list's
 * project headings. With no Mac there is nothing to filter.
 */
export function HeaderButtons({ paired }: { paired: boolean }) {
  return (
    <View className="-mr-2.5 flex-row">
      {paired ? <FilterButton /> : null}
      <SettingsButton />
    </View>
  );
}
