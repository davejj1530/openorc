import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { Dimensions, type HostInstance } from "react-native";
import { chunksInView } from "./mono-lines";

/**
 * Where the tool sheet is scrolled to, for long output that draws only the lines near the screen. `content` is the
 * view everything in the sheet sits in, which blocks of lines measure their place against.
 */
export function createSheetWindow() {
  let view = { top: 0, height: Dimensions.get("window").height };
  const listeners = new Set<() => void>();
  const remeasures = new Set<() => void>();
  const announce = () => listeners.forEach((listener) => listener());
  return {
    content: { current: null } as RefObject<HostInstance | null>,
    view: () => view,
    scrolled(top: number, height: number) {
      if (top === view.top && height === view.height) return;
      view = { top, height };
      announce();
    },
    /** Something in the sheet changed size, so blocks of lines below it moved. */
    resized: () => remeasures.forEach((remeasure) => remeasure()),
    announce,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onResize(remeasure: () => void) {
      remeasures.add(remeasure);
      return () => {
        remeasures.delete(remeasure);
      };
    },
  };
}

export const SheetWindowContext = createContext(createSheetWindow());

/**
 * Which of a block's chunks of lines, each `chunkHeight` tall but the last, to draw, first to last, and `measure` for
 * the block's column of lines to call when it lays out. The block re-renders only when that range changes.
 */
export function useChunksInView(column: RefObject<HostInstance | null>, chunks: number, chunkHeight: number): { range: [number, number]; measure: () => void } {
  const sheet = useContext(SheetWindowContext);
  const offset = useRef<number | null>(null);
  const measure = useCallback(() => {
    const content = sheet.content.current;
    if (!content) return;
    column.current?.measureLayout(content, (_x, y) => {
      if (y === offset.current) return;
      offset.current = y;
      sheet.announce();
    });
  }, [sheet, column]);
  useEffect(() => sheet.onResize(measure), [sheet, measure]);
  const key = useSyncExternalStore(sheet.subscribe, () => chunksInView(sheet.view(), offset.current, chunks, chunkHeight).join(":"));
  const [first = 0, last = -1] = key.split(":").map(Number);
  return { range: [first, last], measure };
}
