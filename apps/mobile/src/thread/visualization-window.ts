import type { LegendListRef } from "@legendapp/list/react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { Row } from "./rows";
import type { FrameMemory } from "./visualization-frame";

/** At most this many visualizations keep a live web view at once; each is a page with its own web process share. */
export const LIVE_FRAMES = 3;

/**
 * How long the list must rest before frames come and go. A web view starting or ending costs the UI thread two to
 * four frames, which a reader would see as a stutter while the list moves; at rest it passes unseen.
 */
export const SETTLE_MS = 150;

/** How long a thread with visualizations must rest, after it opens, before WebKit warms up (see `WebKitWarmUp`). */
export const WARM_UP_MS = 500;

/** The rows the list shows (`start` to `end`) and the rows it draws around them, by index. */
export interface ListWindow {
  start: number;
  end: number;
  startBuffered: number;
  endBuffered: number;
}

/** A visualization row and where it sits in the transcript. */
export interface FramedRow {
  key: string;
  index: number;
}

/**
 * The visualizations that may hold a live web view, nearest the screen first, at most `max`. A web view starts only on
 * screen: one started off screen holds its page back until it comes into view, then starts it in the middle of the
 * scroll that brings it in, where its hitch shows. One already live (`held`) stays while the list draws it, and while
 * the list follows its end (`following`) even once it no longer does.
 */
export function liveFrames(rows: readonly FramedRow[], view: ListWindow, held: ReadonlySet<string> = new Set(), following = false, max = LIVE_FRAMES): Set<string> {
  const away = (row: FramedRow) => Math.max(0, view.start - row.index, row.index - view.end);
  const shown = (row: FramedRow) => row.index >= view.start && row.index <= view.end;
  const drawn = (row: FramedRow) => row.index >= view.startBuffered && row.index <= view.endBuffered;
  const live = rows.filter((row) => shown(row) || (held.has(row.key) && (following || drawn(row))));
  return new Set(
    live
      .sort((a, b) => away(a) - away(b))
      .slice(0, max)
      .map((row) => row.key),
  );
}

/** The visualizations on screen, not just drawn near it. */
export const shownFrames = (rows: readonly FramedRow[], view: ListWindow): Set<string> => new Set(rows.filter((row) => row.index >= view.start && row.index <= view.end).map((row) => row.key));

const differ = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a, ...b].filter((key) => a.has(key) !== b.has(key));

/**
 * Which visualizations of one open thread hold a live web view and which are on screen, and what each frame last
 * showed, so one that leaves its web view keeps its place in the list. Outside a list (`all`) every frame is live and
 * shown.
 */
export function createFrameWindow(all = false) {
  let live = new Set<string>();
  let shown = new Set<string>();
  const kept = new Map<string, FrameMemory>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    isLive: (key: string): boolean => all || live.has(key),
    isShown: (key: string): boolean => all || shown.has(key),
    live: (): ReadonlySet<string> => live,
    update(nextLive: Set<string>, nextShown: Set<string> = shown): void {
      const changed = new Set([...differ(live, nextLive), ...differ(shown, nextShown)]);
      live = nextLive;
      shown = nextShown;
      for (const key of changed) listeners.get(key)?.forEach((listener) => listener());
    },
    kept: (key: string): FrameMemory | undefined => kept.get(key),
    keep: (key: string, memory: FrameMemory): void => void kept.set(key, memory),
    /** The reader asked for a fresh page: one that failed comes back loading, one that drew keeps its height. */
    retry(key: string): void {
      if (kept.get(key)?.kind === "failed") kept.delete(key);
    },
    subscribe(key: string, listener: () => void): () => void {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    },
  };
}

export type FrameWindow = ReturnType<typeof createFrameWindow>;

export const FrameWindowContext = createContext<FrameWindow>(createFrameWindow(true));

/** Whether the visualization row `key` may hold a live web view now, and whether it is on screen. */
export function useFrame(key: string): { live: boolean; shown: boolean } {
  const frames = useContext(FrameWindowContext);
  const subscribe = useCallback((listener: () => void) => frames.subscribe(key, listener), [frames, key]);
  const live = useSyncExternalStore(subscribe, () => frames.isLive(key));
  const shown = useSyncExternalStore(subscribe, () => frames.isShown(key));
  return { live, shown };
}

export const useFrameWindow = (): FrameWindow => useContext(FrameWindowContext);

/**
 * The open thread's frame window, following the list. At the end, where new content arrives and a following list
 * keeps moving, `place` brings in the frames on screen at once and lets none go (its window flickers as it lays
 * out new rows, and a reply streaming in moves it a line at a time, so it never truly rests): it runs when the list has
 * laid out its first rows, as a scroll reaches the end, and when rows change there. Away from the end, `placeAtRest`
 * waits for the reader's scroll to rest, then brings in and lets go both. Frames stay at most `LIVE_FRAMES`, the
 * farthest going first. Nothing is read from the list while the thread has no visualization. `warm` turns true once
 * the list has rested for `WARM_UP_MS` in a thread where the reader may meet a visualization: one it shows, or one in
 * the older history it has yet to load (`older`).
 */
export function useFramePlacement(rows: readonly Row[], listRef: RefObject<LegendListRef | null>, older: boolean) {
  const [frames] = useState(() => createFrameWindow());
  const framed = useMemo(() => rows.flatMap((row, index) => (row.kind === "visualization" ? [{ key: row.key, index }] : [])), [rows]);
  const placed = useRef(framed);
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [warm, setWarm] = useState(false);
  const warming = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mayFrame = useRef(false);
  const apply = useCallback(
    (rested: boolean) => {
      const state = placed.current.length ? listRef.current?.getState() : undefined;
      if (state) frames.update(liveFrames(placed.current, state, frames.live(), !rested), shownFrames(placed.current, state));
    },
    [frames, listRef],
  );
  // Any move or new row puts the warm-up off until the list has rested for a while.
  const warmAtRest = useCallback(() => {
    clearTimeout(warming.current);
    if (mayFrame.current) warming.current = setTimeout(setWarm, WARM_UP_MS, true);
  }, []);
  const placeAtRest = useCallback(() => {
    clearTimeout(resting.current);
    if (placed.current.length) resting.current = setTimeout(apply, SETTLE_MS, true);
    warmAtRest();
  }, [apply, warmAtRest]);
  const place = useCallback(() => {
    clearTimeout(resting.current);
    apply(false);
    warmAtRest();
  }, [apply, warmAtRest]);
  // New rows at the end are news to show now; rows landing while the reader moves through history (an older page)
  // wait for the scroll to rest like any other.
  useEffect(() => {
    placed.current = framed;
    mayFrame.current = older || framed.length > 0;
    if (listRef.current?.getState().isAtEnd ?? true) place();
    else placeAtRest();
  }, [framed, older, place, placeAtRest, listRef]);
  useEffect(
    () => () => {
      clearTimeout(resting.current);
      clearTimeout(warming.current);
    },
    [],
  );
  return { frames, place, placeAtRest, warm };
}
