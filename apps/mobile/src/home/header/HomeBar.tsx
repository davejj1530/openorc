import { Link } from "expo-router";
import { useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import type { LinkState } from "../../connection/manager";
import { ChevronDown } from "../../generated/icons";
import { SpaceMark } from "../../spaces/SpaceMark";
import { spaceName, titleName, useSpaces } from "../../spaces/use-spaces";
import { cn } from "../../ui/cn";
import { LinkDot } from "../../ui/LinkDot";
import { ScrollEdge } from "../../ui/ScrollEdge";
import { Wordmark, WORDMARK_MAX_SCALE } from "../../ui/Wordmark";
import type { HomeTab } from "../BottomBar";
import { HeaderButtons } from "./HeaderButtons";
import { StatusWords, useMacLine, type HomeScroll } from "./MacLine";

/** The bar's height: `pt-1` over a 52 pt row, the header circles' 40 and 6 around them. The list starts under it. */
export const HOME_BAR_HEIGHT = 56;

/** The room the status keeps from the title before it (`ml-4`) and the circles after it (`mr-3`). */
const STATUS_INSET = { start: 16, end: 12 };

/** Whether the status fits whole in the room after the title, both measured; not until both are. */
const statusFits = (room: number | null, status: number | null): boolean => room !== null && status !== null && STATUS_INSET.start + status + STATUS_INSET.end <= room;

/**
 * What is wrong with the link, after the title: the dot and the short status, which open the connection sheet as the
 * connection button does. Nothing while the link is healthy, or while a quick connect holds its words back. It stands
 * in the room the title leaves, at its own size and whole, and where it does not fit it leaves: the space's name never
 * loses a letter to it, and its words never shrink. It is laid out at the window's width so it measures whole.
 */
function StatusRoom({ state }: { state: Exclude<LinkState, { kind: "unpaired" }> }) {
  const line = useMacLine(state);
  const window = useWindowDimensions().width;
  const [room, setRoom] = useState<number | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const fits = statusFits(room, width);
  return (
    <View testID="status-room" className="flex-1 self-stretch overflow-hidden" onLayout={(event) => setRoom(event.nativeEvent.layout.width)}>
      {line.trouble && line.status ? (
        <View pointerEvents="box-none" className="absolute inset-y-0 left-4 flex-row items-center" style={{ width: window }}>
          <Link href="/connection" asChild>
            <Pressable
              testID="link-status"
              accessibilityRole="button"
              accessibilityLabel={line.label}
              accessibilityElementsHidden={!fits}
              importantForAccessibility={fits ? "auto" : "no-hide-descendants"}
              pointerEvents={fits ? "auto" : "none"}
              onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
              className={cn("flex-row items-center gap-1.5 self-stretch active:opacity-60", !fits && "opacity-0")}
            >
              <LinkDot tone={line.tone} />
              <StatusWords status={line.status} trouble={line.trouble} maxFontSizeMultiplier={WORDMARK_MAX_SCALE} />
            </Pressable>
          </Link>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The bar's title for a paired Mac: OpenOrc's wordmark, or, once the Mac says who is signed in to OpenOrc on it, the
 * space Home shows, by its mark and name in the wordmark's place and type, Personal as OpenOrc, as the Mac's sidebar
 * heads it. That one opens the spaces to choose from.
 */
function Title() {
  const account = useSpaces();
  if (account.state !== "ready") return <Wordmark className="self-stretch" />;
  const space = account.current;
  return (
    <Link href="/space" asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={space.kind === "personal" ? "OpenOrc, Personal space" : `${spaceName(space)}, space`}
        hitSlop={4}
        className="shrink flex-row items-center gap-1.5 self-stretch active:opacity-60"
      >
        <Wordmark name={titleName(space)} mark={(size) => <SpaceMark space={space} size={size} />} className="shrink" />
        <ChevronDown size={16} className="text-ink-4" />
      </Pressable>
    </Link>
  );
}

/**
 * Home's first row, pinned as an opaque bar over the status bar's room so rows never show sliced under the clock: the
 * wordmark on the grid's lead and text columns, the header circles trailing (the connection among them), and the hairline
 * that comes in once rows scroll under it, as the thread screen's bar and the sheets draw their edge. While the link is
 * not healthy, the bar says so after the title, where it fits whole. With no Mac nothing scrolls, so there is no hairline or status to show.
 */
export function HomeBar({ state, scroll, tab, listed }: { state: LinkState; scroll?: HomeScroll; tab?: HomeTab; listed?: boolean }) {
  return (
    <View className="px-5 pt-1">
      <View className="h-13 flex-row items-center">
        {state.kind === "unpaired" ? <Wordmark className="self-stretch" /> : <Title />}
        {state.kind === "unpaired" ? <View className="flex-1" /> : <StatusRoom state={state} />}
        <HeaderButtons state={state} tab={tab} listed={listed} />
      </View>
      {scroll ? <ScrollEdge scrollY={scroll.scrollY} /> : null}
    </View>
  );
}
