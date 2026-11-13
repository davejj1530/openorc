import { Link } from "expo-router";
import { Pressable, View } from "react-native";
import type { LinkState } from "../../connection/manager";
import { LinkDot } from "../../ui/LinkDot";
import { TopFade } from "../../ui/ScrollFade";
import { Wordmark, WORDMARK_MAX_SCALE } from "../../ui/Wordmark";
import type { HomeTab } from "../BottomBar";
import { HeaderButtons } from "./HeaderButtons";
import { StatusWords, useMacLine, type HomeScroll } from "./MacLine";

/** The bar's height: `pt-1` over a 52 pt row, the header circles' 40 and 6 around them. The list starts under it. */
export const HOME_BAR_HEIGHT = 56;

/**
 * What is wrong with the link, after the wordmark: the dot and the short status, which open the connection sheet as
 * the connection button does. Nothing while the link is healthy, or while a quick connect holds its words back. It
 * grows no more than the wordmark, and on a narrow screen at a large text size it shrinks rather than cut its words.
 */
function PinnedStatus({ state }: { state: Exclude<LinkState, { kind: "unpaired" }> }) {
  const line = useMacLine(state);
  if (!line.trouble || !line.status) return null;
  return (
    <Link href="/connection" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={line.label} className="ml-4 shrink flex-row items-center gap-1.5 self-stretch active:opacity-60">
        <LinkDot tone={line.tone} />
        <StatusWords status={line.status} trouble={line.trouble} className="shrink" adjustsFontSizeToFit maxFontSizeMultiplier={WORDMARK_MAX_SCALE} />
      </Pressable>
    </Link>
  );
}

/**
 * Home's first row, pinned as an opaque bar over the status bar's room so rows never show sliced under the clock: the
 * wordmark on the grid's lead and text columns, the header circles trailing (the connection among them), and a fade
 * rows pass into once they scroll under it. While the link is not healthy, the bar says so after the wordmark, which
 * never moves. With no Mac nothing scrolls, so there is no fade or status to show.
 */
export function HomeBar({ state, scroll, tab }: { state: LinkState; scroll?: HomeScroll; tab?: HomeTab }) {
  return (
    <View className="px-5 pt-1">
      <View className="h-13 flex-row items-center">
        <Wordmark className="self-stretch" />
        {state.kind === "unpaired" ? null : <PinnedStatus state={state} />}
        <View className="flex-1" />
        <HeaderButtons state={state} tab={tab} />
      </View>
      {scroll ? <TopFade scrollY={scroll.scrollY} /> : null}
    </View>
  );
}
