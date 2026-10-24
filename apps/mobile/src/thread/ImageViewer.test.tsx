// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { nativeProps } from "../test-fixtures/react-native";
import { ImageViewer } from "./ImageViewer";

afterEach(cleanup);

type Gesture = { kind: string; config: { enabled?: boolean; onDeactivate?: (event: { translationY: number; velocityY: number }) => void } };

/** The viewer as the person meets it: the image's scroll view, and its swipe down. */
function viewer() {
  const onClose = vi.fn();
  render(<ImageViewer uri="file:///cache/shot.png" label="Generated image" onClose={onClose} />);
  const scroll = () => nativeProps.get(screen.getByLabelText("Generated image").parentElement!)!;
  const swipeDown = () => {
    const detector = Array.from(document.querySelectorAll("div")).find((element) => nativeProps.get(element)?.gesture);
    return (nativeProps.get(detector!)!.gesture as { gestures: Gesture[] }).gestures.find((gesture) => gesture.kind === "pan")!;
  };
  const zoomTo = (event: "onScroll" | "onScrollEndDrag" | "onMomentumScrollEnd", zoomScale: number) => act(() => (scroll()[event] as (event: object) => void)({ nativeEvent: { zoomScale } }));
  return { onClose, scroll, swipeDown, zoomTo };
}

it("swipes the image away at its whole size, where the scroll view does not bounce to take the drag", () => {
  const shown = viewer();
  expect(shown.scroll().alwaysBounceVertical).toBe(false);
  expect(shown.swipeDown().config.enabled).toBe(true);
  act(() => shown.swipeDown().config.onDeactivate!({ translationY: 200, velocityY: 0 }));
  expect(shown.onClose).toHaveBeenCalledOnce();
});

it("pans a zoomed image instead of swiping it away, reading the zoom where a pinch or a double tap ends", () => {
  const shown = viewer();
  shown.zoomTo("onScrollEndDrag", 2.4);
  expect(shown.swipeDown().config.enabled).toBe(false);
  expect(shown.scroll().alwaysBounceVertical).toBe(true);
  shown.zoomTo("onMomentumScrollEnd", 1);
  expect(shown.swipeDown().config.enabled).toBe(true);
  expect(shown.scroll().alwaysBounceVertical).toBe(false);
  shown.zoomTo("onScroll", 2);
  expect(shown.swipeDown().config.enabled).toBe(false);
});
