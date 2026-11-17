import { edgeWords, nearestPast, pastEdges, scrollToBring, type EdgeTarget, type ListEdges } from "@openorc/client";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Pressable, View } from "react-native";
import { useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ChevronDown } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { useReducedMotion } from "../ui/reduced-motion";
import { Text } from "../ui/Text";
import type { HomeCall } from "./home-items";
import { MARGIN, ROW_INSET } from "./grid";
import { ThreadStatusMark } from "./ThreadStatusMark";

/** How much of the list's view an edge's line covers, at touch height. */
export const EDGE_LINE = 44;

const NONE: ListEdges = { above: [], below: [] };
const same = (a: ListEdges, b: ListEdges) => a.above.join() === b.above.join() && a.below.join() === b.below.join();

/**
 * Where each call's item sits in the list's content: where the list laid it out, or, for one it has not rendered yet,
 * where it reckons it from the sizes it has seen, so a call far down the list still counts.
 */
function measure(list: LegendListRef, calls: readonly HomeCall[]): EdgeTarget[] {
  const state = list.getState();
  return calls.flatMap((call) => {
    const index = state.indexByKey(call.anchor);
    if (index === undefined) return [];
    const top = state.positionAtIndex(index);
    return [{ id: call.id, top, bottom: top + state.sizeAtIndex(index) }];
  });
}

/**
 * What calls the person past each edge of Home's list, measured as it scrolls and as its rows change, and a press that
 * brings the nearest one past an edge whole into view. `covered` is how much of the list's view the bars over it hide
 * at the top and the bottom, where a row reads as past the edge; `start` is how far into the scrolling content the
 * first row starts (the top padding and the list's header), as the list counts its rows' positions from there.
 */
export function useHomeEdges(list: RefObject<LegendListRef | null>, calls: readonly HomeCall[], scrollY: SharedValue<number>, covered: { top: number; bottom: number }, start: number) {
  const latest = useRef(calls);
  latest.current = calls;
  const [edges, setEdges] = useState<ListEdges>(NONE);
  const still = useReducedMotion();
  const view = useCallback(() => {
    const state = list.current?.getState();
    // The rows' positions count from the first row; the scroll offset counts from the content's top.
    const top = state ? state.scroll + covered.top - start : 0;
    return state ? { top, bottom: top + state.scrollLength - covered.top - covered.bottom } : null;
  }, [list, covered.top, covered.bottom, start]);
  const update = useCallback(() => {
    const shown = view();
    if (!list.current || !shown) return;
    const next = pastEdges(measure(list.current, latest.current), shown, EDGE_LINE);
    setEdges((old) => (same(old, next) ? old : next));
  }, [list, view]);
  useAnimatedReaction(
    () => Math.round(scrollY.value / 8),
    (step, before) => {
      if (step !== before) scheduleOnRN(update);
    },
  );
  const key = calls.map((call) => `${call.id}@${call.anchor}`).join();
  // After the list lays out the rows a change brings.
  useEffect(() => {
    const timer = setTimeout(update, 50);
    return () => clearTimeout(timer);
  }, [key, update]);
  const bring = (edge: keyof ListEdges) => {
    const id = nearestPast(edges, edge);
    const shown = view();
    const target = list.current && shown ? measure(list.current, latest.current).find((each) => each.id === id) : undefined;
    if (!target || !shown) return;
    haptic.select();
    const to = scrollToBring(target, { top: shown.top, height: shown.bottom - shown.top }, EDGE_LINE);
    void list.current?.scrollToOffset({ offset: Math.max(0, to + start - covered.top), animated: !still });
  };
  return { edges, bring };
}

/**
 * The lines at the list's edges, as the desktop's sidebar draws them: an amber chevron where the rows' marks lead, then
 * the one thread past that edge with its mark, or how many need the person. A press brings the nearest whole into view.
 */
export function EdgeLines({ edges, calls, covered, onBring }: { edges: ListEdges; calls: readonly HomeCall[]; covered: { top: number; bottom: number }; onBring: (edge: keyof ListEdges) => void }) {
  const byId = new Map(calls.map((call) => [call.id, call]));
  return (["above", "below"] as const).map((edge) => {
    const past = edges[edge];
    if (!past.length) return null;
    const one = past.length === 1 ? byId.get(past[0]!) : undefined;
    const words = edgeWords(past, (id) => byId.get(id)?.title ?? "");
    return (
      <View key={edge} pointerEvents="box-none" className="absolute inset-x-0 z-10" style={edge === "above" ? { top: covered.top } : { bottom: covered.bottom }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${words}, ${edge === "above" ? "above" : "below"}`}
          onPress={() => onBring(edge)}
          className="mx-3 flex-row items-center gap-2 rounded-lg bg-bg active:bg-surface-2"
          style={{ height: EDGE_LINE, paddingLeft: MARGIN - ROW_INSET, paddingRight: MARGIN - ROW_INSET }}
        >
          <View style={edge === "above" ? { transform: [{ rotate: "180deg" }] } : undefined}>
            <ChevronDown size={16} className="text-warn" />
          </View>
          <Text numberOfLines={1} className="flex-1 text-detail text-ink">
            {words}
          </Text>
          {one ? <ThreadStatusMark mark={one.status} /> : null}
        </Pressable>
      </View>
    );
  });
}
