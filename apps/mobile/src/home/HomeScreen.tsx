import { LegendList } from "@legendapp/list/react-native";
import { Link, router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, queryClient, useLinkState } from "../client";
import { useLinkWords } from "../connection/use-link-words";
import type { LinkState, LostMac } from "../connection/manager";
import { Funnel, Pin, Plus } from "../generated/icons";
import { LinkDot } from "../macs/LinkDot";
import { reportFirstFrame } from "../startup";
import { usePerfAutoOpen } from "../thread/PerfProbe";
import { haptic } from "../ui/haptics";
import { useColors } from "../ui/mode";
import { OpenOrcMark } from "../ui/OpenOrcMark";
import { swipes } from "../ui/swipe";
import { Text } from "../ui/Text";
import { FILTER_CHOICES, filterChoice, useHomeFilter } from "./filter";
import { HomeHeading, RetryRow, SectionToggle, ShowMore } from "./HomeHeading";
import type { HomeItem } from "./home-items";
import { refreshHome } from "./refresh";
import { ThreadRow } from "./ThreadRow";
import { useHomeItems } from "./use-home-items";

type Paired = Exclude<LinkState, { kind: "unpaired" }>;
type Home = ReturnType<typeof useHomeItems>;

function HomeRow({ item, home }: { item: HomeItem; home: Home }) {
  switch (item.kind) {
    case "heading":
      return <HomeHeading heading={item} onToggle={() => item.projectId && home.toggle(item.key, item.projectId)} />;
    case "section":
      return <SectionToggle section={item} onToggle={() => home.toggle(item.key, item.projectId)} />;
    case "thread":
      return <ThreadRow thread={item.thread} project={item.project} arriving={item.arriving} />;
    case "more":
      return <ShowMore project={item.project} onPress={() => home.showMore(item.projectId)} />;
    case "retry":
      return <RetryRow projects={item.projectId === null} onPress={() => home.retry(item.projectId)} />;
  }
}

/** The filter's mark, as the sidebar's: orcmode and pins show their own, inked while the list is narrowed. */
function FilterButton() {
  const choice = filterChoice(useHomeFilter());
  const colors = useColors();
  const narrowed = choice !== "active";
  const label = FILTER_CHOICES.find((item) => item.choice === choice)?.label;
  return (
    <Link href="/filter" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={narrowed ? `Show, ${label}` : "Show"} className="size-touch items-center justify-center rounded-full active:bg-surface-2">
        {choice === "orc" ? <OpenOrcMark size={16} color={colors.ink} working={false} /> : null}
        {choice === "pinned" ? <Pin size={16} className="text-ink" /> : null}
        {choice === "active" || choice === "archived" ? <Funnel size={16} className={narrowed ? "text-ink" : "text-ink-4"} /> : null}
      </Pressable>
    </Link>
  );
}

/**
 * The title, the Mac this shows with its connection dot, and a quiet line while the phone is not connected. The line's
 * room is always kept, so its coming and going never moves the rows under a finger. Pull to refresh tries again now.
 */
function Title({ state }: { state: Paired }) {
  const words = useLinkWords(state);
  const line = words.quiet ? null : words.line;
  return (
    <View className="px-5 pb-1 pt-3">
      <View className="flex-row items-center">
        <Text accessibilityRole="header" className="text-title-sm">
          Threads
        </Text>
        <View className="flex-1" />
        <FilterButton />
        <Link href="/macs" asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${state.mac.name}, ${words.status}`}
            className="-mr-3 min-h-touch max-w-48 flex-row items-center gap-2 rounded-full px-3 active:bg-surface-2"
          >
            <LinkDot tone={words.tone} />
            <Text numberOfLines={1} className="text-sm text-ink-4">
              {state.mac.name}
            </Text>
          </Pressable>
        </Link>
      </View>
      {/* A space holds a line's height at any text size. */}
      <Text numberOfLines={1} importantForAccessibility={line ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!line} className="text-sm text-ink-4">
        {line ?? " "}
      </Text>
    </View>
  );
}

/** Pull to refresh: the lists again, or the connection now. iOS taps as the pull lets go. */
function useRefresh() {
  const [refreshing, setRefreshing] = useState(false);
  return {
    refreshing,
    onRefresh: () => {
      setRefreshing(true);
      void refreshHome(link, queryClient).finally(() => setRefreshing(false));
    },
  };
}

function Threads({ state }: { state: Paired }) {
  const insets = useSafeAreaInsets();
  const home = useHomeItems();
  const refresh = useRefresh();
  return (
    <LegendList
      data={home.items}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.kind}
      recycleItems
      renderItem={({ item }) => <HomeRow item={item} home={home} />}
      ListHeaderComponent={<Title state={state} />}
      ListFooterComponent={<View className="h-24" />}
      contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      // The list lowers the spinner by its top padding, below the status bar's cover. Without a tint, iOS draws none.
      refreshControl={<RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColorClassName="accent-ink-3" />}
    />
  );
}

const lostWords: Record<LostMac["why"], (name: string) => string> = {
  removed: (name) => `${name} removed this phone.`,
  "key-lost": (name) => `This phone lost its key for ${name}.`,
};

/** No Mac yet: one quiet way in, and why the last Mac went when the person did not forget it. */
function Unpaired({ lost }: { lost: LostMac | null }) {
  const told = useRef<LostMac | null>(null);
  useEffect(() => {
    if (!lost || told.current === lost) return;
    told.current = lost;
    haptic.warn();
  }, [lost]);
  return (
    <View className="flex-1 items-center justify-center gap-2 px-10">
      {lost ? <Text className="text-center text-ink-4">{lostWords[lost.why](lost.macName)}</Text> : null}
      <Text accessibilityRole="header" className="text-xl">
        Pair with your Mac
      </Text>
      <Text className="text-center text-ink-4">Scan the code OpenOrc shows on your Mac.</Text>
      <Link href="/pair" asChild>
        <Pressable accessibilityRole="button" className="mt-4 min-h-touch justify-center rounded-full bg-accent px-5 active:opacity-80">
          <Text className="text-md text-accent-fg">Scan code</Text>
        </Pressable>
      </Link>
    </View>
  );
}

const newThread = () => router.push("/new");

/**
 * Home: the shown Mac's threads grouped by project on the tile ground, with New thread as the screen's one ink pill.
 * The pill comes first for VoiceOver, as New thread leads the desktop's sidebar, and a two-finger double tap starts one.
 */
export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const state = useLinkState();
  useEffect(reportFirstFrame, []);
  usePerfAutoOpen();
  if (state.kind === "unpaired") {
    return (
      <View className="flex-1 bg-bg">
        <Unpaired lost={state.lost} />
      </View>
    );
  }
  return (
    <View className="flex-1 bg-bg" onMagicTap={newThread} onTouchStart={swipes.touched}>
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 z-10 items-center" style={{ paddingBottom: insets.bottom }}>
        <Pressable accessibilityRole="button" onPress={newThread} className="mb-2 min-h-touch flex-row items-center gap-2 rounded-full bg-accent pl-4 pr-5 active:opacity-80">
          <Plus size={16} className="text-accent-fg" />
          <Text className="text-md text-accent-fg">New thread</Text>
        </Pressable>
      </View>
      <Threads state={state} />
      {/* Rows scroll under the status bar on the tile, not over it. */}
      <View className="absolute inset-x-0 top-0 bg-bg" style={{ height: insets.top }} />
    </View>
  );
}
