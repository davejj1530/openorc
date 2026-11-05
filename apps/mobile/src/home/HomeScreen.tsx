import { AnimatedLegendList } from "@legendapp/list/reanimated";
import type { ThreadSummary } from "@openorc/protocol";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, partnerClient, partnerLink, queryClient, useHostGroup, useLinkState, usePartnerLinkState, useSavedMacs } from "../client";
import { HostScope } from "../connection/HostScope";
import type { LinkState } from "../connection/manager";
import { Plus } from "../generated/icons";
import { reportFirstFrame } from "../startup";
import { usePerfAutoOpen } from "../thread/PerfProbe";
import { swipes } from "../ui/swipe";
import { Text } from "../ui/Text";
import { HOME_BAR_HEIGHT, HomeBar } from "./header/HomeBar";
import { MacLine, lineOverRows, type HomeScroll } from "./header/MacLine";
import { HomeHeading, RetryRow, SectionToggle, ShowMore } from "./HomeHeading";
import type { HomeItem, Waiting } from "./home-items";
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
    case "thread": {
      const row = <ThreadRow thread={item.thread} project={item.project} arriving={item.arriving} tree={item.tree} onToggle={() => home.toggleThread(item.thread.id, item.tree.expanded)} />;
      return item.host ? <HostScope host={item.host}>{row}</HostScope> : row;
    }
    case "more":
      return <ShowMore project={item.project} onPress={() => home.showMore(item.projectId)} />;
    case "retry":
      return <RetryRow projects={item.projectId === null} onPress={() => home.retry(item.projectId)} />;
  }
}

/** Pull to refresh: the lists again, the partner's too, or the connection now. iOS taps as the pull lets go. */
function useRefresh(partner: string | null) {
  const [refreshing, setRefreshing] = useState(false);
  return {
    refreshing,
    onRefresh: () => {
      setRefreshing(true);
      void refreshHome(link, queryClient, partner ? { link: partnerLink, queryClient: partnerClient.queryClient } : null).finally(() => setRefreshing(false));
    },
  };
}

/** Rows another host owns, marked with it: the shown host's when it cannot be reached, every row of the partner's. */
function owned(items: HomeItem[], owner: NonNullable<ThreadSummary["owner"]>): HomeItem[] {
  return items.map((item) => (item.kind === "thread" && !item.host ? { ...item, thread: { ...item.thread, owner } } : item));
}

const NO_WAITING: readonly Waiting[] = [];

/** How the partner host's rows are marked: whose they are, and whether it answers now. */
function usePartnerOwner(partner: string | null): NonNullable<ThreadSummary["owner"]> {
  const state = usePartnerLinkState();
  const brain = useSavedMacs().find((host) => host.id === partner)?.kind === "brain";
  const away = brain ? "asleep" : "offline";
  const reach = state.kind === "connected" ? "live" : away;
  return useMemo(() => ({ brain: brain ? "cloud" : "mac", reach, heardAt: Date.now() }), [brain, reach]);
}

/**
 * The partner host's threads, under its own heading and scope: a tap opens them on that host. Its threads waiting on
 * you go up to the shown host's Needs you, handed over only when they change.
 */
function PartnerThreads({ partner, onWaiting }: { partner: string; onWaiting: (waiting: readonly Waiting[]) => void }) {
  const state = usePartnerLinkState();
  const home = useHomeItems(state.kind === "connected", { waitingShownElsewhere: true });
  const name = useSavedMacs().find((host) => host.id === partner)?.name;
  const items = owned(home.items, usePartnerOwner(partner));
  const waiting = JSON.stringify(home.waiting);
  useEffect(() => onWaiting(JSON.parse(waiting) as Waiting[]), [waiting, onWaiting]);
  useEffect(() => () => onWaiting(NO_WAITING), [onWaiting]);
  return (
    <View className="pb-24">
      <Text className="mx-5 mt-6 mb-1 text-sm text-ink-3">{name ?? "Cloud"}</Text>
      {items.map((item) => (
        <HomeRow key={item.key} item={item} home={home} />
      ))}
    </View>
  );
}

function Threads({ state, scrollY, lineBottom }: HomeScroll & { state: Paired }) {
  const insets = useSafeAreaInsets();
  const group = useHostGroup();
  const [partnerWaiting, setPartnerWaiting] = useState(NO_WAITING);
  const partnerOwner = usePartnerOwner(group.partner);
  const handed = useMemo(
    () => (group.partner ? partnerWaiting.map((each) => ({ ...each, host: group.partner!, thread: { ...each.thread, owner: partnerOwner } })) : NO_WAITING),
    [group.partner, partnerWaiting, partnerOwner],
  );
  const shown = useHomeItems(state.kind === "connected", { partnerWaiting: handed });
  const brain = useSavedMacs().find((host) => host.id === group.primary)?.kind === "brain";
  const away = { brain: brain ? "cloud" : "mac", reach: brain ? "asleep" : "offline", heardAt: Date.now() } as const;
  const home = group.partner && state.kind !== "connected" ? { ...shown, items: owned(shown.items, away) } : shown;
  const refresh = useRefresh(group.partner);
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
      ListFooterComponent={
        group.partner ? (
          <HostScope host={group.partner}>
            <PartnerThreads partner={group.partner} onWaiting={setPartnerWaiting} />
          </HostScope>
        ) : (
          <View className="h-24" />
        )
      }
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
