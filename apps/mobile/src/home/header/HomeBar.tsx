import { Link } from "expo-router";
import { Pressable, View } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from "react-native-reanimated";
import { showsDemo, type LinkState } from "../../connection/manager";
import { LinkDot } from "../../ui/LinkDot";
import { ScrollEdge } from "../../ui/ScrollEdge";
import { Wordmark, WORDMARK_MAX_SCALE } from "../../ui/Wordmark";
import { HeaderButtons, type BarFor } from "./HeaderButtons";
import { StatusWords, useLineUnder, useMacLine, type HomeScroll, type MacLineWords } from "./MacLine";

/** The bar's height: `pt-1` over the 44 pt touch row. The list starts under it. */
export const HOME_BAR_HEIGHT = 48;

/** Points of scroll over which the status comes into the bar as the end of the Mac line slides under it. */
const HANDOVER = 8;

/**
 * What is wrong with the link, after the wordmark, once the Mac line that says it has scrolled under the bar: the
 * dot and the short status, which open Settings as the line does. VoiceOver finds it only while it shows. It grows no
 * more than the wordmark, and on a narrow screen at a large text size it shrinks rather than cut its words. It fills
 * the row's height, as the wordmark and the buttons do, so VoiceOver reads the row from the leading edge.
 */
function PinnedWords({ line, status, scrollY, lineBottom }: HomeScroll & { line: MacLineWords; status: string }) {
  const shown = useLineUnder({ scrollY, lineBottom });
  const fade = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [lineBottom.value - HANDOVER, lineBottom.value], [0, 1], Extrapolation.CLAMP) }));
  return (
    <Animated.View
      style={fade}
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      className="ml-4 shrink self-stretch"
    >
      <Link href="/settings" asChild>
        <Pressable accessibilityRole="button" accessibilityLabel={line.label} className="flex-1 flex-row items-center gap-1.5 active:opacity-60">
          <LinkDot tone={line.tone} />
          <StatusWords status={status} trouble={line.trouble} className="shrink" adjustsFontSizeToFit maxFontSizeMultiplier={WORDMARK_MAX_SCALE} />
        </Pressable>
      </Link>
    </Animated.View>
  );
}

/** Nothing while the link is healthy, or while a quick connect holds its words back. */
function PinnedStatus({ state, ...scroll }: HomeScroll & { state: Exclude<LinkState, { kind: "unpaired" }> }) {
  const line = useMacLine(state);
  return line.trouble && line.status ? <PinnedWords line={line} status={line.status} {...scroll} /> : null;
}

/**
 * Home's first row, pinned as an opaque bar over the status bar's room so rows never show sliced under the clock: the
 * wordmark on the list's leading edge, the filter and Settings trailing, and a hairline once rows pass under it. While
 * the link is not healthy and the Mac line has scrolled away, the bar says so after the wordmark, which never moves.
 * With no Mac nothing scrolls, so there is no hairline or status to show.
 */
export function HomeBar({ state, scroll }: { state: LinkState; scroll?: HomeScroll }) {
  let shows: BarFor = state.kind === "unpaired" ? "unpaired" : "paired";
  if (showsDemo(state)) shows = "demo";
  return (
    <View className="px-5 pt-1">
      <View className="h-touch flex-row items-center">
        <Wordmark className="self-stretch" />
        {scroll && state.kind !== "unpaired" ? <PinnedStatus state={state} {...scroll} /> : null}
        <View className="flex-1" />
        <HeaderButtons shows={shows} />
      </View>
      {scroll ? <ScrollEdge scrollY={scroll.scrollY} /> : null}
    </View>
  );
}
