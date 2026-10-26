import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, queryClient, useLinkState } from "../client";
import type { LinkState } from "../connection/manager";
import { Plus } from "../generated/icons";
import { reportFirstFrame } from "../startup";
import { usePerfAutoOpen } from "../thread/PerfProbe";
import { swipes } from "../ui/swipe";
import { Text } from "../ui/Text";
import { HOME_BAR_HEIGHT, HomeBar } from "./header/HomeBar";
import { MacLine, lineOverRows, type HomeScroll } from "./header/MacLine";
import { HomeHeading, RetryRow, SectionToggle, ShowMore } from "./HomeHeading";
import type { HomeItem } from "./home-items";
import { refreshHome } from "./refresh";
import { ThreadRow } from "./ThreadRow";
import { Unpaired } from "./Unpaired";
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

function Threads({ state, scrollY, lineBottom }: HomeScroll & { state: Paired }) {
  const insets = useSafeAreaInsets();
  const home = useHomeItems(state.kind === "connected");
  const refresh = useRefresh();
  // One object for the list's life: a new one each render would make the list resubscribe and rewrite the offset.
  const sharedValues = useMemo(() => ({ scrollOffset: scrollY }), [scrollY]);
  return (
    <AnimatedLegendList
      data={home.items}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.kind}
      recycleItems
      renderItem={({ item }) => <HomeRow item={item} home={home} />}
      ListHeaderComponent={<MacLine state={state} scrollY={scrollY} lineBottom={lineBottom} />}
      ListHeaderComponentStyle={lineOverRows}
      ListFooterComponent={<View className="h-24" />}
      sharedValues={sharedValues}
      contentContainerStyle={{ paddingTop: insets.top + HOME_BAR_HEIGHT, paddingBottom: insets.bottom }}
      // The list lowers the spinner by its top padding, below the bar. Without a tint, iOS draws none.
      refreshControl={<RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColorClassName="accent-ink-3" />}
    />
  );
}

const newThread = () => router.push("/new");

/**
 * A paired Mac's threads grouped by project on the tile ground, under the pinned bar, with New thread as the screen's
 * one ink pill; a two-finger double tap starts one. Where the list has scrolled lives here, so a Mac shown again after
 * none starts at the top.
 */
function PairedHome({ state }: { state: Paired }) {
  const insets = useSafeAreaInsets();
  const scrollY = useSharedValue(0);
  // Until the line lays out, where its words end at the default text size.
  const lineBottom = useSharedValue(16);
  const scroll = useMemo(() => ({ scrollY, lineBottom }), [scrollY, lineBottom]);
  return (
    <View className="flex-1 bg-bg" onMagicTap={newThread} onTouchStart={swipes.touched}>
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 z-10 items-center" style={{ paddingBottom: insets.bottom }}>
        <Pressable accessibilityRole="button" onPress={newThread} className="mb-2 min-h-touch flex-row items-center gap-2 rounded-full bg-accent pl-4 pr-5 active:opacity-80">
          <Plus size={16} className="text-accent-fg" />
          <Text className="text-md text-accent-fg">New thread</Text>
        </Pressable>
      </View>
      {/* The bar over the status bar's room, so rows scroll under it. */}
      <View className="absolute inset-x-0 top-0 z-10 bg-bg" style={{ paddingTop: insets.top }}>
        <HomeBar state={state} scroll={scroll} />
      </View>
      <Threads state={state} {...scroll} />
    </View>
  );
}

/** Home: the shown Mac's threads, or pairing when there is none. */
export function HomeScreen() {
  const state = useLinkState();
  useEffect(reportFirstFrame, []);
  usePerfAutoOpen();
  return state.kind === "unpaired" ? <Unpaired state={state} /> : <PairedHome state={state} />;
}
