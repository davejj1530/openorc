import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { Block } from "@openorc/client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { Pressable, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useReducedMotion, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowDown } from "../generated/icons";
import { arrive } from "../ui/motion";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { AgentPresence } from "./AgentPresence";
import { newArrivals, useArrival } from "./arrivals";
import { countArrivals } from "./perf-probe";
import { Card } from "./cards";
import { Notice, Prompt, Reply } from "./messages";
import { emptyRowMemo, fixedHeight, newestRow, transcriptRows, unsentRows, type Row } from "./rows";
import { TurnActions } from "./TurnActions";
import { TurnHead } from "./TurnHead";
import { WorkRow } from "./WorkRow";

/** What a scroll event says about where the reader is. */
type ScrollPosition = { contentOffset: { y: number }; layoutMeasurement: { height: number }; contentSize: { height: number }; contentInset?: { bottom?: number } };

/** How near the end still counts as reading the newest turn. */
const AT_END = 24;

function RowView({ row }: { row: Row }): ReactElement | null {
  switch (row.kind) {
    case "prompt":
      return <Prompt block={row.block} />;
    case "notice":
      return <Notice block={row.block} />;
    case "head":
      return <TurnHead row={row} />;
    case "work":
      return <WorkRow row={row} />;
    case "reply":
      return <Reply text={row.text} streaming={row.streaming} source={row.source} />;
    case "card":
      return <Card block={row.block} runId={row.runId} />;
    case "actions":
      return <TurnActions row={row} />;
    case "presence":
      return <AgentPresence working={row.working} />;
  }
}

const spacing = new Map<number, { paddingTop: number }>();
/** The space above a row, as a style object shared by every row with that space. */
const spaced = (gap: number) => spacing.get(gap) ?? spacing.set(gap, { paddingTop: gap }).get(gap)!;

/**
 * A row that arrived while the thread was open rises in once; history is simply there. Every row has the same
 * wrapper, and the list hands views from one item to the next: a row keeps what it shows in its props or in state
 * keyed to it. A card remounts instead, so it never shows another card's half-made answer. An arriving row's wrapper
 * is keyed to it, so its rise starts afresh even in a view another row just left.
 */
const ListRow = memo(function ListRow({ row, arrivals }: { row: Row; arrivals: Set<string> }) {
  const play = useArrival(row.key, arrivals);
  return (
    <Animated.View key={play ? row.key : undefined} style={play ? [spaced(row.gap), arrive] : spaced(row.gap)}>
      <RowView key={row.kind === "card" ? row.key : undefined} row={row} />
    </Animated.View>
  );
});

/**
 * The rows that arrived live and have not risen in yet. Everything on screen when the first page lands is history,
 * and older pages land above the known rows, so neither animates.
 */
function useArrivals(rows: Row[], filled: boolean): Set<string> {
  const known = useRef(new Set<string>());
  const [arrivals] = useState(() => new Set<string>());
  const settled = useRef(false);
  const still = useReducedMotion();
  useMemo(() => {
    const arrived = newArrivals(rows, known.current);
    if (settled.current && !still) {
      arrived.forEach((key) => arrivals.add(key));
      countArrivals(arrived.length);
    }
    settled.current ||= filled;
  }, [rows, filled, still, arrivals]);
  return arrivals;
}

/** A quiet chip over the composer when something new came in below where the reader is. */
function NewChip({ composerInset, onPress }: { composerInset: SharedValue<number>; onPress: () => void }) {
  const still = useReducedMotion();
  const insets = useSafeAreaInsets();
  const keyboard = useReanimatedKeyboardAnimation();
  const place = useAnimatedStyle(() => ({ bottom: composerInset.value + Math.max(0, -keyboard.height.value - insets.bottom) + 12 }));
  return (
    <Animated.View className="absolute inset-x-0 items-center" style={[place, still ? undefined : arrive]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show new messages"
        onPress={onPress}
        className="h-control-lg flex-row items-center gap-1.5 rounded-full bg-surface px-3.5 active:bg-surface-3"
      >
        <ArrowDown size={14} className="text-ink-3" />
        <Text className="text-sm text-ink-2">New</Text>
      </Pressable>
    </Animated.View>
  );
}

export interface TranscriptProps {
  blocks: Block[];
  /** The newest turn may still run. */
  live: boolean;
  /** The thread is busy, its agent's presence with it. */
  working: boolean;
  runId: string;
  hasOlder: boolean;
  loadOlder: () => void;
  /** History is in: the first page has loaded, so rows from now on arrive live. */
  filled: boolean;
  /** The composer's height, which the list keeps clear at its end. */
  composerInset: SharedValue<number>;
  listRef: RefObject<LegendListRef | null>;
  /** The reader is at the newest turn; new content keeps them there. */
  onFollow: (following: boolean) => void;
  following: boolean;
  /** Changes when the person sends, which returns the view to the newest turn to follow the message. */
  followKey: number;
}

/**
 * The conversation as a list of rows, opening at the newest turn. Older turns load a page at a time as the reader
 * nears the top, without moving what they read. While the reader is at the end, new content keeps them there; scrolled
 * up, a New chip offers the way back.
 */
export function Transcript({ blocks, live, working, runId, hasOlder, loadOlder, filled, composerInset, listRef, onFollow, following, followKey }: TranscriptProps) {
  const memo = useRef(emptyRowMemo());
  const rows = useMemo(() => transcriptRows(blocks, { live, working }, runId, memo.current), [blocks, live, working, runId]);
  const arrivals = useArrivals(rows, filled);
  const last = newestRow(rows);
  // The newest row the reader saw before scrolling up; any change to the end after that is news.
  const seen = useRef<Row | null>(null);
  if (following) seen.current = last;

  const nearStart = useRef(false);
  // Only the reader lets go of the end. Layout moves the list too (rows measuring, the keyboard, a page above), and
  // those moves must not stop it following; reaching the end by any route resumes it.
  const touching = useRef(false);
  const onScroll = useCallback(
    ({ nativeEvent }: { nativeEvent: ScrollPosition }) => {
      const { contentOffset, layoutMeasurement, contentSize, contentInset } = nativeEvent;
      const atEnd = contentOffset.y + layoutMeasurement.height - (contentInset?.bottom ?? 0) >= contentSize.height - AT_END;
      nearStart.current = contentOffset.y < layoutMeasurement.height;
      if (atEnd || touching.current) onFollow(atEnd);
    },
    [onFollow],
  );
  const grab = useCallback(() => {
    touching.current = true;
  }, []);
  const settle = useCallback(
    (event: { nativeEvent: ScrollPosition }) => {
      onScroll(event);
      touching.current = false;
    },
    [onScroll],
  );
  const showNew = !following && filled && seen.current !== null && last !== seen.current;
  const toEnd = () => {
    onFollow(true);
    void listRef.current?.scrollToEnd({ animated: true });
  };
  // A page that lands while the top is still in reach asks for the next one, as the desktop keeps loading while the
  // top stays in view; the list's own start callback fires only when a scroll crosses into it.
  useEffect(() => {
    const state = listRef.current?.getState();
    const fits = Boolean(state && state.contentLength <= state.scrollLength);
    if (hasOlder && filled && (fits || nearStart.current)) loadOlder();
  }, [rows, hasOlder, filled, loadOlder, listRef]);
  const sent = useRef(followKey);
  useEffect(() => {
    if (sent.current === followKey) return;
    sent.current = followKey;
    touching.current = false;
    onFollow(true);
    void listRef.current?.scrollToEnd({ animated: false });
  }, [followKey, onFollow, listRef]);

  return (
    <View className="flex-1">
      <RowList
        rows={rows}
        arrivals={arrivals}
        hasOlder={hasOlder}
        filled={filled}
        following={following}
        loadOlder={loadOlder}
        composerInset={composerInset}
        listRef={listRef}
        onScroll={onScroll}
        onGrab={grab}
        onSettle={settle}
      />
      {showNew ? <NewChip composerInset={composerInset} onPress={toEnd} /> : null}
    </View>
  );
}

interface RowListProps {
  rows: Row[];
  arrivals: Set<string>;
  hasOlder: boolean;
  filled: boolean;
  following: boolean;
  loadOlder: () => void;
  composerInset: SharedValue<number>;
  listRef: RefObject<LegendListRef | null>;
  onScroll: (event: { nativeEvent: ScrollPosition }) => void;
  onGrab: () => void;
  onSettle: (event: { nativeEvent: ScrollPosition }) => void;
}

const keyOf = (row: Row) => row.key;
const kindOf = (row: Row) => row.kind;
const contentStyle = { paddingHorizontal: 12 };
const footer = <View className="h-4" />;

/** The list itself, which renders only when its rows or its place change: a streamed word reaches only its piece. */
const RowList = memo(function RowList({ rows, arrivals, hasOlder, filled, following, loadOlder, composerInset, listRef, onScroll, onGrab, onSettle }: RowListProps) {
  const insets = useSafeAreaInsets();
  const renderItem = useCallback(({ item }: { item: Row }) => <ListRow row={item} arrivals={arrivals} />, [arrivals]);
  const alwaysRender = useMemo(() => ({ keys: unsentRows(rows) }), [rows]);
  return (
    <KeyboardAwareLegendList
      ref={listRef}
      data={rows}
      keyExtractor={keyOf}
      getItemType={kindOf}
      getFixedItemSize={fixedHeight}
      renderItem={renderItem}
      recycleItems
      alwaysRender={alwaysRender}
      estimatedItemSize={72}
      drawDistance={600}
      initialScrollAtEnd
      alignItemsAtEnd
      maintainScrollAtEnd={following ? { animated: false } : false}
      maintainVisibleContentPosition={{ data: true }}
      onStartReached={hasOlder ? loadOlder : undefined}
      onStartReachedThreshold={1}
      onScroll={onScroll}
      onScrollBeginDrag={onGrab}
      onScrollEndDrag={onSettle}
      onMomentumScrollEnd={onSettle}
      scrollEventThrottle={32}
      contentInsetEndAdjustment={composerInset}
      keyboardLiftBehavior="whenAtEnd"
      keyboardOffset={insets.bottom}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={hasOlder ? <View className="h-12 items-center justify-center">{filled ? <Spinner /> : null}</View> : null}
      ListFooterComponent={footer}
      contentContainerStyle={contentStyle}
    />
  );
});
