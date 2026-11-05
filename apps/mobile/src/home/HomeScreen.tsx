import { AnimatedLegendList } from "@legendapp/list/reanimated";
import type { ThreadSummary } from "@openorc/protocol";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useContext, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import Animated, { LinearTransition, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, partnerClient, partnerLink, queryClient, useHostGroup, useLinkState, usePartnerLinkState, useSavedMacs } from "../client";
import { HostScope } from "../connection/HostScope";
import { HostContext } from "../connection/host-context";
import type { LinkState } from "../connection/manager";
import { Cloud, Laptop, Plus } from "../generated/icons";
import { motion } from "../generated/tokens";
import { reportFirstFrame } from "../startup";
import { usePerfAutoOpen } from "../thread/PerfProbe";
import { ease } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import { FootFade } from "../ui/ScrollFade";
import { swipes } from "../ui/swipe";
import { Text } from "../ui/Text";
import { rowMotion, useFoldMotion, type RowMotion } from "./fold-motion";
import { HOME_BAR_HEIGHT, HomeBar } from "./header/HomeBar";
import { MacLine, lineOverRows, type HomeScroll } from "./header/MacLine";
import { HomeHeading, RetryRow, SectionToggle, ShowMore, ShowMoreChildren, type HeadingRoom } from "./HomeHeading";
import { newThreadRoute } from "./out-of-reach";
import { owned, type HomeItem, type Waiting } from "./home-items";
import { refreshHome } from "./refresh";
import { ThreadRow } from "./ThreadRow";
import { Unpaired } from "./Unpaired";
import { useHomeItems } from "./use-home-items";

type Paired = Exclude<LinkState, { kind: "unpaired" }>;
type Home = ReturnType<typeof useHomeItems>;
type Fold = (key: string, open: boolean) => void;

/** Rows slide to their new places as a fold opens or closes, over the desktop's resize time. */
const slide = LinearTransition.duration(motion.duration.resize).easing(ease.outTiming);

/**
 * The partner host's section rides at the end of the list as one item rather than its footer, so it slides with the
 * rows over it as their folds move.
 */
const PARTNER = { kind: "partner", key: "partner" } as const;
type Listed = HomeItem | typeof PARTNER;

/** The room above the heading at `index`: none under a folded heading, so a run of folded projects stacks tight. */
function headingRoom(items: readonly HomeItem[], index: number): HeadingRoom {
  if (index === 0) return "first";
  return items[index - 1]!.kind === "heading" ? "after-heading" : "after-rows";
}

function HomeRow({ item, home, index, motion, fold }: { item: HomeItem; home: Home; index: number; motion: RowMotion; fold: Fold }) {
  switch (item.kind) {
    case "heading":
      return <HomeHeading heading={item} room={headingRoom(home.items, index)} motion={motion} onToggle={() => item.projectId && fold(item.key, !(item.open && !motion.folding))} />;
    case "section":
      return <SectionToggle section={item} motion={motion} onToggle={() => fold(item.key, !(item.open && !motion.folding))} />;
    case "thread": {
      const row = <ThreadRow thread={item.thread} project={item.project} arriving={item.arriving} tree={item.tree} motion={motion} onFold={fold} />;
      return item.host ? <HostScope host={item.host}>{row}</HostScope> : row;
    }
    case "more":
      return <ShowMore project={item.project} motion={motion} onPress={() => home.showMore(item.projectId)} />;
    case "children-more":
      return <ShowMoreChildren item={item} motion={motion} onPress={() => home.showMoreChildren(item.tree.thread.projectId, item.tree.thread.id)} />;
    case "retry":
      return <RetryRow projects={item.projectId === null} onPress={() => home.retry(item.projectId)} />;
  }
}

/** Home's folds with their motion: what each fold key names, committed to the host's saved folds. */
function useHomeFolds(home: Home) {
  return useFoldMotion(home.items, (key, open) => {
    const item = home.items.find((each) => (each.kind === "thread" ? each.thread.id : each.key) === key);
    if (item?.kind === "thread") home.toggleThread(item.thread.id, !open);
    else if ((item?.kind === "heading" || item?.kind === "section") && item.projectId) home.toggle(item.key, item.projectId);
  });
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

const NO_WAITING: readonly Waiting[] = [];

/** Home stays mounted under a thread; its selected branch must survive a page refresh there. */
function useSelectedThreadId(): string | undefined {
  const params = useGlobalSearchParams<{ id?: string; host?: string }>();
  const path = usePathname();
  const host = useContext(HostContext);
  return path.startsWith("/thread/") && (params.host ?? null) === host ? params.id : undefined;
}

/** How the partner host's rows are marked: whose they are, and whether it answers now. */
function usePartnerOwner(partner: string | null): NonNullable<ThreadSummary["owner"]> {
  const state = usePartnerLinkState();
  const brain = useSavedMacs().find((host) => host.id === partner)?.kind === "brain";
  const away = brain ? "asleep" : "offline";
  const reach = state.kind === "connected" ? "live" : away;
  return useMemo(() => ({ brain: brain ? "cloud" : "mac", reach, heardAt: Date.now() }), [brain, reach]);
}

/**
 * The partner host's threads waiting on you, handed up to the shown host's Needs you only when they change. It renders
 * nothing and stays mounted beside the list, where the partner's own section may be scrolled out of being drawn.
 */
function PartnerWaiting({ onWaiting }: { onWaiting: (waiting: readonly Waiting[]) => void }) {
  const state = usePartnerLinkState();
  const waiting = JSON.stringify(useHomeItems(state.kind === "connected", { waitingShownElsewhere: true }).waiting);
  useEffect(() => onWaiting(JSON.parse(waiting) as Waiting[]), [waiting, onWaiting]);
  useEffect(() => () => onWaiting(NO_WAITING), [onWaiting]);
  return null;
}

/** The partner host's threads, under its own heading and scope: a tap opens them on that host. */
function PartnerThreads({ partner }: { partner: string }) {
  const state = usePartnerLinkState();
  const home = useHomeItems(state.kind === "connected", { waitingShownElsewhere: true, selectedId: useSelectedThreadId() });
  const name = useSavedMacs().find((host) => host.id === partner)?.name;
  const owner = usePartnerOwner(partner);
  const items = owned(home.items, owner);
  const folds = useHomeFolds(home);
  const still = useReducedMotion();
  const Mark = owner.brain === "cloud" ? Cloud : Laptop;
  return (
    <View className="pb-24">
      {/* The other host's section opens under its name as the shown one's opens under the wordmark, on the same grid. */}
      <View accessible accessibilityRole="header" accessibilityLabel={name ?? "Cloud"} className="mt-8 flex-row items-center gap-3 px-5">
        <View className="w-7 items-center">
          <Mark size={22} className="text-ink-4" />
        </View>
        <Text numberOfLines={1} className="flex-1 text-title-sm">
          {name ?? "Cloud"}
        </Text>
      </View>
      {items.map((item, index) => (
        <Animated.View key={item.key} layout={still ? undefined : slide}>
          <HomeRow item={item} home={{ ...home, items }} index={index} motion={rowMotion(folds.motions, item.key)} fold={folds.toggle} />
        </Animated.View>
      ))}
    </View>
  );
}

/** How the shown host's rows are marked while it cannot be reached and a partner's rows show beside them; null otherwise. */
function useShownAway(state: Paired): NonNullable<ThreadSummary["owner"]> | null {
  const group = useHostGroup();
  const brain = useSavedMacs().find((host) => host.id === group.primary)?.kind === "brain";
  if (!group.partner || state.kind === "connected") return null;
  return { brain: brain ? "cloud" : "mac", reach: brain ? "asleep" : "offline", heardAt: Date.now() };
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
  const shown = useHomeItems(state.kind === "connected", { partnerWaiting: handed, selectedId: useSelectedThreadId() });
  const away = useShownAway(state);
  const home = away ? { ...shown, items: owned(shown.items, away) } : shown;
  const folds = useHomeFolds(home);
  const still = useReducedMotion();
  const refresh = useRefresh(group.partner);
  // One object for the list's life: a new one each render would make the list resubscribe and rewrite the offset.
  const sharedValues = useMemo(() => ({ scrollOffset: scrollY }), [scrollY]);
  return (
    <>
      {group.partner ? (
        <HostScope host={group.partner}>
          <PartnerWaiting onWaiting={setPartnerWaiting} />
        </HostScope>
      ) : null}
      <AnimatedLegendList<Listed>
        data={group.partner ? [...home.items, PARTNER] : home.items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        recycleItems
        itemLayoutAnimation={still ? undefined : slide}
        extraData={folds.motions}
        renderItem={({ item, index }) =>
          item.kind === "partner" ? (
            <HostScope host={group.partner!}>
              <PartnerThreads partner={group.partner!} />
            </HostScope>
          ) : (
            <HomeRow item={item} home={home} index={index} motion={rowMotion(folds.motions, item.key)} fold={folds.toggle} />
          )
        }
        ListHeaderComponent={<MacLine state={state} scrollY={scrollY} lineBottom={lineBottom} />}
        ListHeaderComponentStyle={lineOverRows}
        ListFooterComponent={group.partner ? null : <View className="h-24" />}
        sharedValues={sharedValues}
        contentContainerStyle={{ paddingTop: insets.top + HOME_BAR_HEIGHT, paddingBottom: insets.bottom }}
        // The list lowers the spinner by its top padding, below the bar. Without a tint, iOS draws none.
        refreshControl={<RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColorClassName="accent-ink-3" />}
      />
    </>
  );
}

/** The pill's 48 pt and the 8 under it, and the fade above it that rows pass into. */
const PILL_ROOM = 48 + 8 + 32;

/** New thread on the shown host, or on its cloud brain while the shown Mac cannot be reached. */
function useNewThread(state: Paired): () => void {
  const route = newThreadRoute(useShownAway(state), useHostGroup().partner);
  return () => router.push(route);
}

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
  const newThread = useNewThread(state);
  return (
    <View className="flex-1 bg-bg" onMagicTap={newThread} onTouchStart={swipes.touched}>
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 z-10 items-center" style={{ paddingBottom: insets.bottom }}>
        <FootFade height={insets.bottom + PILL_ROOM} />
        <Pressable accessibilityRole="button" onPress={newThread} className="mb-2 h-12 flex-row items-center gap-2 rounded-full bg-accent pl-5 pr-6 active:opacity-80">
          <Plus size={18} className="text-accent-fg" />
          <Text className="text-lg text-accent-fg">New thread</Text>
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
