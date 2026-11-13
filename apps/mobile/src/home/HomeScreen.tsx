import { AnimatedLegendList } from "@legendapp/list/reanimated";
import type { ThreadSummary } from "@openorc/protocol";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { LinearTransition, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, queryClient, useHostGroup, useLinkState, useSavedMacs } from "../client";
import { HostContext } from "../connection/host-context";
import type { LinkState } from "../connection/manager";
import { Plus } from "../generated/icons";
import { motion } from "../generated/tokens";
import { reportFirstFrame } from "../startup";
import { usePerfAutoOpen } from "../thread/PerfProbe";
import { ease } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import { FootFade } from "../ui/ScrollFade";
import { swipes } from "../ui/swipe";
import { Text } from "../ui/Text";
import { rowMotion, useFoldMotion, type RowMotion } from "./fold-motion";
import { BOTTOM_BAR_ROOM, BottomBar, homeTabs, type HomeTab } from "./BottomBar";
import { useNewAction } from "./new-action";
import { TabLayers } from "./TabLayers";
import { HOME_BAR_HEIGHT, HomeBar } from "./header/HomeBar";
import type { HomeScroll } from "./header/MacLine";
import { HomeHeading, RetryRow, SectionToggle, ShowMore, ShowMoreChildren, type HeadingRoom } from "./HomeHeading";
import { newThreadRoute } from "./out-of-reach";
import { owned, type HomeItem } from "./home-items";
import { refreshHome } from "./refresh";
import { ThreadRow } from "./ThreadRow";
import { Unpaired } from "./Unpaired";
import { useHomeItems } from "./use-home-items";
import { UpdateReady } from "./UpdateReady";
import { useOrclingFaces } from "../orclings/face-row";
import { byRecent, needsYou, useOrclingChats } from "../orclings/orcling-chats";
import { OrclingFaces } from "../orclings/OrclingFaces";
import { OrclingList } from "../orclings/OrclingList";
import { TaskList } from "../tasks/TaskList";
import { useTaskBoard } from "../tasks/use-task-board";

type Paired = Exclude<LinkState, { kind: "unpaired" }>;
type Home = ReturnType<typeof useHomeItems>;
type Fold = (key: string, open: boolean) => void;

/** Rows slide to their new places as a fold opens or closes, over the desktop's resize time. */
const slide = LinearTransition.duration(motion.duration.resize).easing(ease.outTiming);

/** The room above the heading or part at `index`: none right under another, so a run of folded days stacks tight. */
function headingRoom(items: readonly HomeItem[], index: number): HeadingRoom {
  if (index === 0) return "first";
  const before = items[index - 1]!.kind;
  return before === "heading" || before === "section" ? "after-heading" : "after-rows";
}

function HomeRow({ item, home, index, motion, fold }: { item: HomeItem; home: Home; index: number; motion: RowMotion; fold: Fold }) {
  switch (item.kind) {
    case "heading":
      return <HomeHeading heading={item} room={headingRoom(home.items, index)} />;
    case "section":
      return <SectionToggle section={item} room={headingRoom(home.items, index)} motion={motion} onToggle={() => fold(item.key, !(item.open && !motion.folding))} />;
    case "thread":
      return <ThreadRow thread={item.thread} project={item.project} arriving={item.arriving} tree={item.tree} motion={motion} onFold={fold} />;
    case "more":
      return <ShowMore motion={motion} onPress={home.showMore} />;
    case "children-more":
      return <ShowMoreChildren item={item} motion={motion} onPress={() => home.showMoreChildren(item.tree.thread.projectId, item.tree.thread.id)} />;
    case "retry":
      return <RetryRow projects={item.projects} onPress={() => home.retry(item.projects)} />;
  }
}

/** Home's folds with their motion: what each fold key names, committed to the host's saved folds. */
function useHomeFolds(home: Home) {
  return useFoldMotion(home.items, (key, open) => {
    const item = home.items.find((each) => (each.kind === "thread" ? each.thread.id : each.key) === key);
    if (item?.kind === "thread") home.toggleThread(item.thread.id, !open);
    else if (item?.kind === "section") home.toggle(item.key);
  });
}

/** Pull to refresh: the lists again, or the connection now. iOS taps as the pull lets go. */
function useRefresh() {
  const [refreshing, setRefreshing] = useState(false);
  return {
    refreshing,
    onRefresh: () => {
      setRefreshing(true);
      void refreshHome(link, queryClient, null).finally(() => setRefreshing(false));
    },
  };
}

/** Home stays mounted under a thread; its selected branch must survive a page refresh there. */
function useSelectedThreadId(): string | undefined {
  const params = useGlobalSearchParams<{ id?: string; host?: string }>();
  const path = usePathname();
  const host = useContext(HostContext);
  return path.startsWith("/thread/") && (params.host ?? null) === host ? params.id : undefined;
}

/** How the shown host's rows are marked while it cannot be reached and a partner's rows show beside them; null otherwise. */
function useShownAway(state: Paired): NonNullable<ThreadSummary["owner"]> | null {
  const group = useHostGroup();
  const brain = useSavedMacs().find((host) => host.id === group.primary)?.kind === "brain";
  if (!group.partner || state.kind === "connected") return null;
  return { brain: brain ? "cloud" : "mac", reach: brain ? "asleep" : "offline", heardAt: Date.now() };
}

function Threads({ state, scrollY, header }: HomeScroll & { state: Paired; header: ReactNode }) {
  const insets = useSafeAreaInsets();
  // One host at a time, as the switch chose it: the other's threads are its own to show.
  const shown = useHomeItems(state.kind === "connected", { selectedId: useSelectedThreadId() });
  const away = useShownAway(state);
  const home = away ? { ...shown, items: owned(shown.items, away) } : shown;
  const folds = useHomeFolds(home);
  const still = useReducedMotion();
  const refresh = useRefresh();
  // One object for the list's life: a new one each render would make the list resubscribe and rewrite the offset.
  const sharedValues = useMemo(() => ({ scrollOffset: scrollY }), [scrollY]);
  return (
    <>
      <AnimatedLegendList<HomeItem>
        data={home.items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        recycleItems
        itemLayoutAnimation={still ? undefined : slide}
        extraData={folds.motions}
        renderItem={({ item, index }) => <HomeRow item={item} home={home} index={index} motion={rowMotion(folds.motions, item.key)} fold={folds.toggle} />}
        ListHeaderComponent={<>{header}</>}
        ListFooterComponent={<View className="h-24" />}
        sharedValues={sharedValues}
        contentContainerStyle={{ paddingTop: insets.top + HOME_BAR_HEIGHT, paddingBottom: insets.bottom }}
        // The list lowers the spinner by its top padding, below the bar. Without a tint, iOS draws none.
        refreshControl={<RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColorClassName="accent-ink-3" />}
      />
    </>
  );
}

/** The bar and the 8 under it, and the fade above it that rows pass into. */
const PILL_ROOM = BOTTOM_BAR_ROOM + 32;

/** New thread on the shown host, or on its cloud brain while the shown Mac cannot be reached. */
function useNewThread(state: Paired): () => void {
  const route = newThreadRoute(useShownAway(state), useHostGroup().partner);
  return () => router.push(route);
}

/**
 * A paired Mac's threads by the day they last saw work on the tile ground, under the pinned bar, with New thread as the screen's
 * one ink pill; a two-finger double tap starts one. Where the list has scrolled lives here, so a Mac shown again after
 * none starts at the top.
 */
function PairedHome({ state }: { state: Paired }) {
  const insets = useSafeAreaInsets();
  const scrollY = useSharedValue(0);
  const scroll = useMemo(() => ({ scrollY }), [scrollY]);
  const newThread = useNewThread(state);
  const orclings = useOrclingChats();
  const faces = useOrclingFaces();
  const tasks = useTaskBoard().available;
  const tabs = homeTabs({ orclings: orclings.supported, tasks });
  const [chosen, setTab] = useState<HomeTab>("threads");
  // A Mac too old for Orclings and task lists keeps Home as it was: threads alone, under the New thread pill.
  const tab = tabs.includes(chosen) ? chosen : "threads";
  const action = useNewAction(tab, newThread);
  return (
    <View className="flex-1 bg-bg" onMagicTap={newThread} onTouchStart={swipes.touched}>
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 z-10 items-center" style={{ paddingBottom: insets.bottom }}>
        <FootFade height={insets.bottom + PILL_ROOM} />
        <UpdateReady />
        {tabs.length > 1 ? (
          <BottomBar tab={tab} tabs={tabs} onTab={setTab} badge={faces ? 0 : orclings.chats.filter(needsYou).length} action={action} />
        ) : (
          <Pressable accessibilityRole="button" onPress={newThread} className="mb-2 h-12 flex-row items-center gap-2 rounded-full bg-accent pl-5 pr-6 active:opacity-80">
            <Plus size={18} className="text-accent-fg" />
            <Text className="text-lg text-accent-fg">New thread</Text>
          </Pressable>
        )}
      </View>
      {/* The bar over the status bar's room, so rows scroll under it. */}
      <View className="absolute inset-x-0 top-0 z-10 bg-bg" style={{ paddingTop: insets.top }}>
        <HomeBar state={state} scroll={scroll} tab={tab} />
      </View>
      <TabLayers
        tab={tab}
        render={(each) => {
          if (each === "orclings") return <OrclingList chats={byRecent(orclings.chats)} top={HOME_BAR_HEIGHT} bottom={PILL_ROOM} shown={tab === "orclings"} />;
          if (each === "tasks") return <TaskList top={HOME_BAR_HEIGHT} bottom={PILL_ROOM} />;
          return <Threads state={state} {...scroll} header={faces ? <OrclingFaces chats={orclings.chats} /> : null} />;
        }}
      />
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
