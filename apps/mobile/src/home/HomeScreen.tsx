import { RNHostView } from "@expo/ui/swift-ui";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react-native";
import { Pressable, RefreshControl, View } from "react-native";
import { LinearTransition, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, queryClient, teamChat, useLinkState, whatsNew } from "../client";
import { ChatList } from "../chat/ChatList";
import { useChatLease } from "../chat/lease";
import type { LinkState } from "../connection/manager";
import { Plus } from "../generated/icons";
import { motion } from "../generated/tokens";
import { useListOpen, useSplit } from "../layout";
import { reportFirstFrame } from "../startup";
import { usePerfAutoOpen } from "../thread/PerfProbe";
import { useColors } from "../ui/mode";
import { ease } from "../ui/motion";
import { OpenOrcMark } from "../ui/OpenOrcMark";
import { Measure } from "../ui/pane";
import { useReducedMotion } from "../ui/reduced-motion";
import { FootFade } from "../ui/ScrollFade";
import { swipes } from "../ui/swipe";
import { Text } from "../ui/Text";
import { rowMotion, useFoldMotion, type RowMotion } from "./fold-motion";
import { BOTTOM_BAR_ROOM, BottomBar, homeTabs, NewMenu, type HomeTab } from "./BottomBar";
import { useNewAction } from "./new-action";
import { TabLayers } from "./TabLayers";
import { HOME_BAR_HEIGHT, HomeBar } from "./header/HomeBar";
import type { HomeScroll } from "./header/MacLine";
import { DayLabel, NoResolved, NoThreadsYet, ProjectLabel, ResolvedDoor, RetryRow, SectionToggle, ShowMore, ShowMoreChildren, ShowMoreInGroup } from "./HomeHeading";
import type { HomeItem } from "./home-items";
import { refreshHome } from "./refresh";
import { ThreadRow } from "./ThreadRow";
import { EdgeLines, useHomeEdges } from "./EdgeLines";
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

function HomeRow({ item, home, motion, fold, shownId }: { item: HomeItem; home: Home; motion: RowMotion; fold: Fold; shownId: string | undefined }) {
  switch (item.kind) {
    case "project":
      return <ProjectLabel group={item} room={item.room} motion={motion} onToggle={() => fold(item.key, !(item.open && !motion.folding))} />;
    case "section":
      return <SectionToggle section={item} room={item.room} motion={motion} onToggle={() => fold(item.key, !(item.open && !motion.folding))} />;
    case "thread":
      return (
        <ThreadRow
          thread={item.thread}
          project={item.project}
          arriving={item.arriving}
          tree={item.tree}
          cloudLabel={item.cloudLabel}
          motion={motion}
          onFold={fold}
          shown={item.thread.id === shownId}
        />
      );
    case "day":
      return <DayLabel label={item.label} motion={motion} />;
    case "resolved":
      return <ResolvedDoor open={item.open && !motion.folding} motion={motion} onToggle={() => fold(item.key, !(item.open && !motion.folding))} />;
    case "resolved-more":
      return <ShowMore motion={motion} onPress={() => home.showMoreResolved(item.projectId)} />;
    case "resolved-none":
      return <NoResolved pending={item.pending} motion={motion} />;
    case "more":
      return <ShowMore motion={motion} onPress={home.showMore} />;
    case "group-more":
      return <ShowMoreInGroup count={item.count} motion={motion} onPress={() => home.showMoreInGroup(item.projectId)} />;
    case "children-more":
      return <ShowMoreChildren item={item} motion={motion} onPress={() => home.showMoreChildren(item.tree.thread.projectId, item.tree.thread.id)} />;
    case "retry":
      return <RetryRow projects={item.projects} onPress={() => home.retry(item.projects)} />;
    case "empty":
      return <NoThreadsYet />;
  }
}

/** Home's folds with their motion: what each fold key names, committed to the host's saved folds. */
function useHomeFolds(home: Home) {
  return useFoldMotion(home.items, (key, open) => {
    const item = home.items.find((each) => (each.kind === "thread" ? each.thread.id : each.key) === key);
    if (item?.kind === "thread") home.toggleThread(item.thread.id, !open);
    else if (item?.kind === "section" || item?.kind === "project" || item?.kind === "resolved") home.toggle(item.key);
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

/**
 * The thread that is open, or whose panel is: Home stays mounted under it, or beside it where the window splits, and
 * its selected branch must survive a page refresh there.
 */
function useSelectedThreadId(): string | undefined {
  const params = useGlobalSearchParams<{ id?: string; threadId?: string }>();
  return usePathname().startsWith("/thread/") ? params.id : params.threadId;
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

/** Home's foot: the tabs with their action, or, for a Mac too old for Orclings and task lists, New alone: a thread at a tap, or its menu. */
function HomeFoot({
  tabs,
  tab,
  onTab,
  badge,
  action,
  onNew,
}: {
  tabs: HomeTab[];
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  badge: number;
  action: ReturnType<typeof useNewAction>;
  onNew: () => void;
}) {
  if (tabs.length > 1) return <BottomBar tab={tab} tabs={tabs} onTab={onTab} badge={badge} action={action} />;
  if (action.kind === "menu")
    return (
      <View className="mb-2">
        <NewMenu action={action}>
          <RNHostView matchContents>
            <NewPill label={action.label} />
          </RNHostView>
        </NewMenu>
      </View>
    );
  return (
    <Pressable accessibilityRole="button" onPress={onNew} className="mb-2 active:opacity-80">
      <NewPill label="New thread" />
    </Pressable>
  );
}

/** The ink pill a Home with no tabs starts things from. */
function NewPill({ label }: { label: string }) {
  return (
    <View className="h-12 flex-row items-center gap-2 rounded-full bg-accent pl-5 pr-6">
      <Plus size={18} className="text-accent-fg" />
      <Text className="text-lg text-accent-fg">{label}</Text>
    </View>
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
  const selectedId = useSelectedThreadId();
  const home = useHomeItems(state.kind === "connected", { selectedId });
  const list = useRef<LegendListRef>(null);
  // The bars hide the list's ends: a row under either reads as past that edge.
  const covered = useMemo(() => ({ top: insets.top + HOME_BAR_HEIGHT, bottom: insets.bottom + BOTTOM_BAR_ROOM + 4 }), [insets.top, insets.bottom]);
  const [headerHeight, setHeaderHeight] = useState(0);
  const edges = useHomeEdges(list, home.calls, scrollY, covered, insets.top + HOME_BAR_HEIGHT + headerHeight);
  const folds = useHomeFolds(home);
  const still = useReducedMotion();
  const refresh = useRefresh();
  // One object for the list's life: a new one each render would make the list resubscribe and rewrite the offset.
  const sharedValues = useMemo(() => ({ scrollOffset: scrollY }), [scrollY]);
  // What a row draws beyond its item: a fold's motion, and whether its thread is the one open.
  const drawn = useMemo(() => ({ motions: folds.motions, selectedId }), [folds.motions, selectedId]);
  return (
    <>
      <AnimatedLegendList<HomeItem>
        ref={list}
        data={home.items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        recycleItems
        itemLayoutAnimation={still ? undefined : slide}
        extraData={drawn}
        renderItem={({ item }) => <HomeRow item={item} home={home} motion={rowMotion(folds.motions, item.key)} fold={folds.toggle} shownId={selectedId} />}
        ListHeaderComponent={
          <View onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
            {header}
            <OutOfReachLine state={state} />
          </View>
        }
        ListFooterComponent={<View className="h-24" />}
        sharedValues={sharedValues}
        contentContainerStyle={{ paddingTop: insets.top + HOME_BAR_HEIGHT, paddingBottom: insets.bottom }}
        // The list lowers the spinner by its top padding, below the bar. Without a tint, iOS draws none.
        refreshControl={<RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColorClassName="accent-ink-3" />}
      />
      <EdgeLines edges={edges.edges} calls={home.calls} covered={covered} onBring={edges.bring} />
    </>
  );
}

/** The bar and the 8 under it, and the fade above it that rows pass into. */
const PILL_ROOM = BOTTOM_BAR_ROOM + 32;

/**
 * A paired Mac's threads by project on the tile ground, under the pinned bar, with New thread as the screen's
 * one ink pill; a two-finger double tap starts one. Where the list has scrolled lives here, so a Mac shown again after
 * none starts at the top.
 */
function PairedHome({ state }: { state: Paired }) {
  const insets = useSafeAreaInsets();
  const scrollY = useSharedValue(0);
  const scroll = useMemo(() => ({ scrollY }), [scrollY]);
  // Over Home, once a launch: the steps on what the update brought, when they are due.
  useEffect(() => {
    if (whatsNew.take()) router.push("/whats-new");
  }, []);
  const orclings = useOrclingChats();
  const faces = useOrclingFaces();
  const tasks = useTaskBoard().available;
  const account = useSpaces();
  // Orclings and the Mac's tasks are the person's own, so they stay with Personal; an organization shows its threads.
  const own = account.state !== "ready" || account.current.kind === "personal";
  // An organization's team chat, where its server has one for the person.
  const chatLease = useChatLease();
  const chat = teamChat.useChatState(chatLease).data?.state === "ready";
  const tabs = homeTabs({ orclings: own && orclings.supported, tasks: own && tasks, chat: !own && chat });
  const [chosen, setTab] = useState<HomeTab>("threads");
  // A Mac too old for Orclings and task lists keeps Home as it was: threads alone, under the New thread pill.
  const tab = tabs.includes(chosen) ? chosen : "threads";
  const open = useListOpen();
  const newThread = useCallback(() => open("/new"), [open]);
  const newTask = useCallback(() => open("/new-task"), [open]);
  const action = useNewAction(tab, { newThread, newTask });
  const standing = spaceStanding(account, state.mac.name, Date.now());
  const closed = standing?.kind === "closed";
  return (
    <Measure className="flex-1 bg-bg" onMagicTap={closed ? undefined : newThread} onTouchStart={swipes.touched}>
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 z-10 items-center" style={{ paddingBottom: insets.bottom }}>
        <FootFade height={insets.bottom + PILL_ROOM} />
        <UpdateReady />
        {closed ? null : <HomeFoot tabs={tabs} tab={tab} onTab={setTab} badge={faces ? 0 : orclings.chats.filter(needsYou).length} action={action} onNew={newThread} />}
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
              if (each === "chat" && chatLease) return <ChatList lease={chatLease} top={HOME_BAR_HEIGHT} bottom={PILL_ROOM} />;
              return <Threads state={state} {...scroll} header={faces && own ? <OrclingFaces chats={orclings.chats} /> : null} />;
            }}
          />
        </CloudOutOfReach.Provider>
      )}
    </Measure>
  );
}

/** What stands beside the list while nothing is open: OpenOrc's mark, quiet on the ground. */
function NothingOpen() {
  const colors = useColors();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="flex-1 items-center justify-center bg-bg">
      <OpenOrcMark size={40} color={colors["line-strong"]} working={false} />
    </View>
  );
}

/** Home's place in the stack: Home itself, or nothing open where the window shows Home beside the stack. */
export function HomeRoute() {
  return useSplit() ? <NothingOpen /> : <HomeScreen />;
}

/** Home: the shown Mac's threads, or pairing when there is none. */
export function HomeScreen() {
  const state = useLinkState();
  useEffect(reportFirstFrame, []);
  usePerfAutoOpen();
  return state.kind === "unpaired" ? <Unpaired state={state} /> : <PairedHome state={state} />;
}
