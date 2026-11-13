import { Link } from "expo-router";
import { Pressable, View } from "react-native";
import { endDemo, useSavedMacs } from "../../client";
import { showsDemo, type LinkState } from "../../connection/manager";
import { Cloud, Funnel, Laptop, Pin, Settings } from "../../generated/icons";
import { LinkDot } from "../../ui/LinkDot";
import { Text } from "../../ui/Text";
import { useMacLine } from "./MacLine";
import type { HomeTab } from "../BottomBar";
import { FILTER_CHOICES, filterChoice, useHomeFilter } from "../filter";

/**
 * A header action, one of a family sized to the wordmark: a 40 pt circle on the plane fill with a 20 pt glyph, its fill
 * deepening while pressed; 44 pt to touch. Its center is the action column's, over the headings' pluses.
 */
const circle = "size-10 items-center justify-center rounded-full bg-surface active:bg-surface-3";
const reach = 2;

/** The filter's mark, as the sidebar's: pins show their own, inked while the list is narrowed. */
export function FilterButton() {
  const choice = filterChoice(useHomeFilter());
  const narrowed = choice !== "all";
  const label = FILTER_CHOICES.find((item) => item.choice === choice)?.label;
  return (
    <Link href="/filter" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={narrowed ? `Show, ${label}` : "Show"} hitSlop={reach} className={circle}>
        {choice === "pinned" ? <Pin size={20} className="text-ink" /> : null}
        {choice === "all" ? <Funnel size={20} className="text-ink-3" /> : null}
      </Pressable>
    </Link>
  );
}

type Paired = Exclude<LinkState, { kind: "unpaired" }>;

/**
 * The host Home shows, as a circle like the others: a laptop for a Mac or a cloud for a cloud brain, and the link's ring
 * in its corner while the phone is not connected. It opens the connection sheet, to switch hosts, try again or pair.
 */
export function ConnectionButton({ state }: { state: Paired }) {
  const line = useMacLine(state);
  const brain = useSavedMacs().find((host) => host.id === state.mac.id)?.kind === "brain";
  const Mark = brain ? Cloud : Laptop;
  return (
    <Link href="/connection" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={line.label} hitSlop={reach} className={circle}>
        <Mark size={20} className="text-ink-3" />
        {line.trouble ? (
          <View className="absolute right-1.5 top-1.5">
            <LinkDot tone={line.tone} />
          </View>
        ) : null}
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
 * The connection, the filter, then Settings outermost, as circles 8 pt apart, Settings' over the plus buttons on the
 * list's project headings. With no Mac there is nothing to connect to or filter, and over the Orclings and Tasks tabs
 * the filter goes: it is the threads'. In the demo Skip takes Settings' place.
 */
export function HeaderButtons({ state, tab = "threads" }: { state: LinkState; tab?: HomeTab }) {
  const shows = barFor(state);
  return (
    <View className="flex-row gap-2">
      {state.kind === "unpaired" ? null : <ConnectionButton state={state} />}
      {shows === "unpaired" || tab !== "threads" ? null : <FilterButton />}
      {shows === "demo" ? <SkipButton /> : <SettingsButton />}
    </View>
  );
}

function barFor(state: LinkState): BarFor {
  if (state.kind === "unpaired") return "unpaired";
  return showsDemo(state) ? "demo" : "paired";
}
