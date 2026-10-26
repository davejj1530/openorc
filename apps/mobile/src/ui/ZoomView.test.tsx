// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { nativeProps, Text } from "../test-fixtures/react-native";
import { ZoomView, type ZoomViewHandle } from "./ZoomView";

afterEach(cleanup);

type Gesture = { kind: string; config: { onActivate?: (event: { x: number; y: number }) => void } };
type ScrollEvent = { nativeEvent: { zoomScale?: number; contentOffset?: { x: number; y: number } } };

/** A page twice as tall as the view, zoomed as a person would: the scroll view's events, and its double tap. */
function zoomed(props: { onZoom?: (scale: number, settled: boolean) => void; gestures?: object[]; doubleTap?: boolean } = {}) {
  const handle = createRef<ZoomViewHandle>();
  render(
    <ZoomView ref={handle} width={390} height={1688} onZoom={props.onZoom} gestures={props.gestures as never} doubleTap={props.doubleTap}>
      <Text>Page</Text>
    </ZoomView>,
  );
  const element = screen.getByText("Page").parentElement!;
  const zoomTo = vi.fn();
  const scrollTo = vi.fn();
  Object.assign(element, { scrollResponderZoomTo: zoomTo });
  // The stand-in view sets its own scrollTo on every render; this one stays.
  Object.defineProperty(element, "scrollTo", { get: () => scrollTo, set: () => undefined });
  const scroll = () => nativeProps.get(element)!;
  const fire = (event: "onScroll" | "onScrollEndDrag" | "onMomentumScrollEnd", nativeEvent: ScrollEvent["nativeEvent"]) =>
    act(() => (scroll()[event] as (event: ScrollEvent) => void)({ nativeEvent }));
  const gestures = () => {
    const detector = Array.from(document.querySelectorAll("div")).find((candidate) => nativeProps.get(candidate)?.gesture);
    return (nativeProps.get(detector!)!.gesture as { gestures: Gesture[] }).gestures;
  };
  const doubleTap = (x: number, y: number) => act(() => gestures().find((gesture) => gesture.kind === "tap")!.config.onActivate!({ x, y }));
  return { handle, scroll, fire, gestures, doubleTap, zoomTo, scrollTo };
}

it("zooms its content from its whole size up to four times, bouncing only while zoomed", () => {
  const view = zoomed();
  expect(view.scroll()).toMatchObject({ minimumZoomScale: 1, maximumZoomScale: 4, alwaysBounceVertical: false });
  view.fire("onScrollEndDrag", { zoomScale: 2.5 });
  expect(view.scroll().alwaysBounceVertical).toBe(true);
});

it("tells how far it zoomed, and whether a pinch has settled there", () => {
  const onZoom = vi.fn();
  const view = zoomed({ onZoom });
  view.fire("onScroll", { zoomScale: 1.5 });
  view.fire("onMomentumScrollEnd", { zoomScale: 2 });
  expect(onZoom.mock.calls).toEqual([
    [1.5, false],
    [2, true],
  ]);
});

it("double taps in twice as close around the tapped point of the page, however far it scrolled, and back out", () => {
  const view = zoomed();
  view.fire("onScroll", { zoomScale: 1, contentOffset: { x: 0, y: 600 } });
  view.doubleTap(195, 400);
  expect(view.zoomTo).toHaveBeenLastCalledWith({ x: 97.5, y: 789, width: 195, height: 422, animated: true });
  view.fire("onScrollEndDrag", { zoomScale: 2 });
  view.doubleTap(195, 400);
  expect(view.zoomTo).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 390, height: 844, animated: true });
});

it("goes back to the top of the whole page at once when asked", () => {
  const onZoom = vi.fn();
  const view = zoomed({ onZoom });
  view.fire("onScrollEndDrag", { zoomScale: 3 });
  act(() => view.handle.current!.reset());
  expect(view.zoomTo).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 390, height: 844, animated: false });
  expect(view.scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
  expect(view.scroll().alwaysBounceVertical).toBe(false);
  expect(onZoom).toHaveBeenLastCalledWith(1, true);
  // At its whole size already, only the scroll goes back: the scroll view zooming to a rect would center a short page.
  view.zoomTo.mockClear();
  act(() => view.handle.current!.reset());
  expect(view.zoomTo).not.toHaveBeenCalled();
  expect(view.scrollTo).toHaveBeenCalledTimes(2);
});

it("puts a page back at its top once a double tap's zoom out settles, and leaves a person's own scrolls alone", () => {
  const view = zoomed();
  view.fire("onScrollEndDrag", { zoomScale: 1, contentOffset: { x: 0, y: 300 } });
  expect(view.scrollTo).not.toHaveBeenCalled();
  view.fire("onScrollEndDrag", { zoomScale: 2 });
  view.doubleTap(195, 400);
  view.fire("onScrollEndDrag", { zoomScale: 1, contentOffset: { x: 0, y: -120 } });
  expect(view.scrollTo).toHaveBeenCalledWith({ x: 0, y: 0, animated: true });
  view.fire("onScrollEndDrag", { zoomScale: 1, contentOffset: { x: 0, y: 300 } });
  expect(view.scrollTo).toHaveBeenCalledTimes(1);
});

it("recognizes the gestures it is given alongside its double tap", () => {
  const swipe = { kind: "pan", config: {} };
  expect(
    zoomed({ gestures: [swipe] })
      .gestures()
      .map((gesture) => gesture.kind),
  ).toEqual(["tap", "pan"]);
});

it("leaves the double tap out when its content takes taps of its own, so no tap waits on a timer", () => {
  const click = { kind: "tap", config: { numberOfTaps: 1 } };
  const view = zoomed({ gestures: [click], doubleTap: false });
  expect(view.gestures()).toEqual([click]);
});

it("reads a point on the view as a point on its content, however far it zoomed and scrolled", () => {
  const view = zoomed();
  expect(view.handle.current!.contentPoint({ x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
  view.fire("onScroll", { zoomScale: 2, contentOffset: { x: 200, y: 100 } });
  expect(view.handle.current!.contentPoint({ x: 100, y: 50 })).toEqual({ x: 150, y: 75 });
});
