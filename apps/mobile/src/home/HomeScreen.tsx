import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { LinearTransition, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, queryClient, useLinkState } from "../client";
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
import { ProjectLabel, RetryRow, SectionToggle, ShowMore, ShowMoreChildren, ShowMoreInGroup, type HeadingRoom } from "./HomeHeading";
import type { HomeItem } from "./home-items";
import { refreshHome } from "./refresh";
import { ThreadRow } from "./ThreadRow";
import { Unpaired } from "./Unpaired";
import { CloudOutOfReach } from "../spaces/cloud-reach";
import { spaceStanding } from "../spaces/cloud-words";
import { useSpaces } from "../spaces/use-spaces";
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

/** The room above the label at `index`: none right under another, so a run of folded groups stacks tight. */
function headingRoom(items: readonly HomeItem[], index: number): HeadingRoom {
  if (index === 0) return "first";
  const before = items[index - 1]!.kind;
  return before === "section" || before === "project" ? "after-heading" : "after-rows";
}

function HomeRow({ item, home, index, motion, fold }: { item: HomeItem; home: Home; index: number; motion: RowMotion; fold: Fold }) {
  switch (item.kind) {
    case "project":
      return <ProjectLabel group={item} room={headingRoom(home.items, index)} motion={motion} onToggle={() => fold(item.key, !(item.open && !motion.folding))} />;
    case "section":
      return <SectionToggle section={item} room={headingRoom(home.items, index)} motion={motion} onToggle={() => fold(item.key, !(item.open && !motion.folding))} />;
    case "thread":
      return <ThreadRow thread={item.thread} project={item.project} arriving={item.arriving} tree={item.tree} cloudLabel={item.cloudLabel} motion={motion} onFold={fold} />;
    case "more":
      return <ShowMore motion={motion} onPress={home.showMore} />;
    case "group-more":
      return <ShowMoreInGroup count={item.count} motion={motion} onPress={() => home.showMoreInGroup(item.projectId)} />;
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
    else if (item?.kind === "section" || item?.kind === "project") home.toggle(item.key);
  });
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

/** Home stays mounted under a thread; its selected branch must survive a page refresh there. */
function useSelectedThreadId(): string | undefined {
  const params = useGlobalSearchParams<{ id?: string }>();
  return usePathname().startsWith("/thread/") ? params.id : undefined;
}

/** One plain line over the list while the Mac cannot reach OpenOrc Cloud: what the list shows is what it last heard. */
function OutOfReachLine({ state }: { state: Paired }) {
  const standing = spaceStanding(useSpaces(), state.mac.name, Date.now());
  if (standing?.kind !== "out-of-reach") return null;
  return (
    <View className="px-5 pb-3 pt-2">
      <Text className="text-md text-ink-3">{standing.words}</Text>
    </View>
  );
}

/** Home's foot: the tabs with their action, or, for a Mac too old for Orclings and task lists, New thread alone. */
function HomeFoot({ tabs, tab, onTab, badge, action }: { tabs: HomeTab[]; tab: HomeTab; onTab: (tab: HomeTab) => void; badge: number; action: ReturnType<typeof useNewAction> }) {
  if (tabs.length > 1) return <BottomBar tab={tab} tabs={tabs} onTab={onTab} badge={badge} action={action} />;
  return (
    <Pressable accessibilityRole="button" onPress={newThread} className="mb-2 h-12 flex-row items-center gap-2 rounded-full bg-accent pl-5 pr-6 active:opacity-80">
      <Plus size={18} className="text-accent-fg" />
      <Text className="text-lg text-accent-fg">New thread</Text>
    </Pressable>
  );
}

/** A space shut to the person: its one sentence where the list would be, and nothing to start or filter. */
function ClosedSpace({ words }: { words: string }) {
  return (
    <View className="flex-1 items-center justify-center px-10" style={{ paddingTop: HOME_BAR_HEIGHT }}>
      <Text accessibilityRole="header" className="text-center text-lg text-ink-3">
        {words}
      </Text>
    </View>
  );
}

function Threads({ state, scrollY, header }: HomeScroll & { state: Paired; header: ReactNode }) {
  const insets = useSafeAreaInsets();
  const home = useHomeItems(state.kind === "connected", { selectedId: useSelectedThreadId() });
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
        ListHeaderComponent={
          <>
            {header}
            <OutOfReachLine state={state} />
          </>
        }
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

const newThread = () => router.push("/new");

/**
 * A paired Mac's threads by project on the tile ground, under the pinned bar, with New thread as the screen's
 * one ink pill; a two-finger double tap starts one. Where the list has scrolled lives here, so a Mac shown again after
 * none starts at the top.
 */
function PairedHome({ state }: { state: Paired }) {
  const insets = useSafeAreaInsets();
  const scrollY = useSharedValue(0);
  const scroll = useMemo(() => ({ scrollY }), [scrollY]);
  const orclings = useOrclingChats();
  const faces = useOrclingFaces();
  const tasks = useTaskBoard().available;
  const account = useSpaces();
  // Orclings and the Mac's tasks are the person's own, so they stay with Personal; an organization shows its threads.
  const own = account.state !== "ready" || account.current.kind === "personal";
  const tabs = homeTabs({ orclings: own && orclings.supported, tasks: own && tasks });
  const [chosen, setTab] = useState<HomeTab>("threads");
  // A Mac too old for Orclings and task lists keeps Home as it was: threads alone, under the New thread pill.
  const tab = tabs.includes(chosen) ? chosen : "threads";
  const action = useNewAction(tab, newThread);
  const standing = spaceStanding(account, state.mac.name, Date.now());
  const closed = standing?.kind === "closed";
  return (
    <View className="flex-1 bg-bg" onMagicTap={closed ? undefined : newThread} onTouchStart={swipes.touched}>
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 z-10 items-center" style={{ paddingBottom: insets.bottom }}>
        <FootFade height={insets.bottom + PILL_ROOM} />
        <UpdateReady />
        {closed ? null : <HomeFoot tabs={tabs} tab={tab} onTab={setTab} badge={faces ? 0 : orclings.chats.filter(needsYou).length} action={action} />}
      </View>
      {/* The bar over the status bar's room, so rows scroll under it. */}
      <View className="absolute inset-x-0 top-0 z-10 bg-bg" style={{ paddingTop: insets.top }}>
        <HomeBar state={state} scroll={scroll} tab={tab} listed={!closed} />
      </View>
      {closed ? (
        <ClosedSpace words={standing.words} />
      ) : (
        <CloudOutOfReach.Provider value={standing?.kind === "out-of-reach"}>
          <TabLayers
            tab={tab}
            render={(each) => {
              if (each === "orclings") return <OrclingList chats={byRecent(orclings.chats)} top={HOME_BAR_HEIGHT} bottom={PILL_ROOM} shown={tab === "orclings"} />;
              if (each === "tasks") return <TaskList top={HOME_BAR_HEIGHT} bottom={PILL_ROOM} />;
              return <Threads state={state} {...scroll} header={faces && own ? <OrclingFaces chats={orclings.chats} /> : null} />;
            }}
          />
        </CloudOutOfReach.Provider>
      )}
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
