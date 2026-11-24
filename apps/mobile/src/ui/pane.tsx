import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useWindowDimensions, View, type HostInstance, type LayoutChangeEvent, type ViewProps } from "react-native";
import { container } from "../generated/tokens";
import { cn } from "./cn";

const PaneWidth = createContext<number | null>(null);

/** How wide the column a view sits in is: the window, or the pane that holds it. */
export function usePaneWidth(): number {
  const window = useWindowDimensions().width;
  return useContext(PaneWidth) ?? window;
}

/**
 * The side padding that holds a list's rows to the reading measure, `gutter` in from its edges. The list stays as wide
 * as its column, so it scrolls from anywhere in it.
 */
export function useMeasuredSides(gutter: number): number {
  return gutter + Math.max(0, (usePaneWidth() - container.chat) / 2);
}

/** A column of the window: what it holds sizes from the column's width, not the window's. */
export function Pane({ width, ...props }: ViewProps & { width: number; className?: string }) {
  return (
    <PaneWidth.Provider value={width}>
      <View {...props} />
    </PaneWidth.Provider>
  );
}

/** Holds what it wraps to the reading measure, in the middle of a column wider than it, and is the pane its views size from. */
export function Measure({ className, ...props }: ViewProps & { className?: string }) {
  const width = Math.min(usePaneWidth(), container.chat);
  return (
    <PaneWidth.Provider value={width}>
      <View className={cn("w-full max-w-chat self-center", className)} {...props} />
    </PaneWidth.Provider>
  );
}

/**
 * A view's own width, for what sizes from it where that is not its pane's: a sheet on an iPad is a card narrower than
 * the window. It is read before the first paint, so nothing draws at another width first; `fallback` stands until then.
 */
export function useOwnWidth(fallback: number): { ref: RefObject<HostInstance | null>; onLayout: (event: LayoutChangeEvent) => void; width: number } {
  const ref = useRef<HostInstance>(null);
  const [own, setOwn] = useState(0);
  useLayoutEffect(() => setOwn(ref.current?.getBoundingClientRect().width ?? 0), []);
  const onLayout = useCallback((event: LayoutChangeEvent) => setOwn(event.nativeEvent.layout.width), []);
  return { ref, onLayout, width: own || fallback };
}
