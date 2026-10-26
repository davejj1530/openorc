// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
import type { FramePoint } from "./frame-fit";
import { FrameView } from "./FrameView";
import type { PreviewImage } from "./use-preview";

afterEach(cleanup);

const frame = (seq: number, pane = "p1", height = 566): PreviewImage => ({ seq, uri: `data:image/jpeg;base64,${seq}`, width: 786, height, pane });
const images = () => Array.from(document.querySelectorAll("img"));
const shown = () => images().map((image) => ({ uri: (nativeProps.get(image)!.source as { uri: string }).uri, front: flatStyle(nativeProps.get(image)!.style).zIndex === 1 }));
const load = (uri: string) => act(() => (nativeProps.get(images().find((image) => (nativeProps.get(image)!.source as { uri: string }).uri === uri)!)!.onLoad as () => void)());

function drawn(first: PreviewImage) {
  const view = render(<FrameView frame={first} label="QA Tick, on Studio" dim={false} onZoom={() => undefined} />);
  return { ...view, next: (next: PreviewImage, dim = false) => view.rerender(<FrameView frame={next} label="QA Tick, on Studio" dim={dim} onZoom={() => undefined} />) };
}

it("decodes each new frame behind the shown one and brings it forward once loaded, so the page never blinks", () => {
  const view = drawn(frame(1));
  load("data:image/jpeg;base64,1");
  view.next(frame(2));
  expect(shown()).toEqual([
    { uri: "data:image/jpeg;base64,1", front: true },
    { uri: "data:image/jpeg;base64,2", front: false },
  ]);
  load("data:image/jpeg;base64,2");
  expect(shown()).toEqual([{ uri: "data:image/jpeg;base64,2", front: true }]);
  view.next(frame(3));
  load("data:image/jpeg;base64,3");
  expect(shown()).toEqual([{ uri: "data:image/jpeg;base64,3", front: true }]);
});

it("fits the frame to the view's width at its own shape, and dims it while the Mac is out of reach", () => {
  const view = drawn(frame(1, "p1", 1572));
  expect(flatStyle(nativeProps.get(images()[0]!)!.style)).toMatchObject({ width: 390, height: 780 });
  view.next(frame(1, "p1", 1572), true);
  expect(String(nativeProps.get(screen.getByLabelText("QA Tick, on Studio"))!.className)).toContain("opacity-50");
});

it("names the page and the Mac to VoiceOver once, and never each frame", () => {
  const view = drawn(frame(1));
  view.next(frame(2));
  expect(screen.getAllByLabelText("QA Tick, on Studio")).toHaveLength(1);
  expect(images().every((image) => nativeProps.get(image)!.accessible === false)).toBe(true);
});

it("goes back to the top of the whole page once another tab's frame comes forward", () => {
  const view = drawn(frame(1));
  load("data:image/jpeg;base64,1");
  const scroll = screen.getByLabelText("QA Tick, on Studio").parentElement!;
  const scrollTo = vi.fn();
  // The stand-in view sets its own scrollTo on every render; this one stays.
  Object.defineProperty(scroll, "scrollTo", { get: () => scrollTo, set: () => undefined });
  view.next(frame(2));
  load("data:image/jpeg;base64,2");
  expect(scrollTo).not.toHaveBeenCalled();
  view.next(frame(3, "p2"));
  expect(scrollTo).not.toHaveBeenCalled();
  load("data:image/jpeg;base64,3");
  expect(scrollTo).toHaveBeenCalledWith({ x: 0, y: 0, animated: false });
});

type Gesture = { kind: string; config: Record<string, unknown> & { onActivate?: (event: object) => void; onUpdate?: (event: object) => void } };

/** A frame with the person's hands on it: its gestures, its scroll view's zoom, and what reached the page. */
function driven() {
  const taps: FramePoint[] = [];
  const scrolls: [FramePoint, number, number][] = [];
  render(
    <FrameView frame={frame(1)} label="QA Buttons, on Studio" dim={false} onZoom={() => undefined} onTap={(point) => taps.push(point)} onScroll={(point, dx, dy) => scrolls.push([point, dx, dy])} />,
  );
  const gestures = () => {
    const detector = Array.from(document.querySelectorAll("div")).find((candidate) => nativeProps.get(candidate)?.gesture);
    return (nativeProps.get(detector!)!.gesture as { gestures: Gesture[] }).gestures;
  };
  const gesture = (kind: string) => gestures().find((each) => each.kind === kind)!;
  const page = () => screen.getByLabelText("QA Buttons, on Studio");
  const zoom = (zoomScale: number, contentOffset = { x: 0, y: 0 }) =>
    act(() => (nativeProps.get(page().parentElement!)!.onScrollEndDrag as (event: object) => void)({ nativeEvent: { zoomScale, contentOffset } }));
  return { taps, scrolls, gestures, gesture, page, zoom };
}

it("clicks where a tap lands, in the frame's own pixels, at once and with no double-tap zoom waiting", () => {
  const view = driven();
  expect(view.gestures().map((each) => [each.kind, each.config["numberOfTaps"] ?? null])).toEqual([
    ["tap", 1],
    ["pan", null],
  ]);
  act(() => view.gesture("tap").config.onActivate!({ x: 195, y: 140.5 }));
  expect(view.taps).toEqual([{ x: 393, y: 283 }]);
  // Below the picture is no page.
  act(() => view.gesture("tap").config.onActivate!({ x: 195, y: 600 }));
  expect(view.taps).toHaveLength(1);
});

it("fails a tap once the finger travels past a touch's slop, so a quick flick scrolls the page without also clicking where it lifts", () => {
  const view = driven();
  // RNGH's tap otherwise fails only past its 500 ms: a flick shorter than that would end as a tap.
  expect(view.gesture("tap").config).toMatchObject({ numberOfTaps: 1, maxDistance: 10 });
});

it("lands a tap on the same pixel of the page when zoomed in twice", () => {
  const view = driven();
  view.zoom(2, { x: 390, y: 0 });
  act(() => view.gesture("tap").config.onActivate!({ x: 195, y: 140.5 }));
  expect(view.taps).toEqual([{ x: 589.5, y: 141.5 }]);
});

it("at its whole size, a one-finger drag scrolls the Mac's page with the finger; zoomed in, it pans the picture instead", () => {
  const view = driven();
  expect(view.gesture("pan").config).toMatchObject({ enabled: true, maxPointers: 1 });
  act(() => view.gesture("pan").config.onUpdate!({ x: 195, y: 100, changeX: 0, changeY: -39 }));
  expect(view.scrolls).toEqual([[{ x: 393, y: 201.42 }, 0, 78.56]]);
  view.zoom(2);
  expect(view.gesture("pan").config.enabled).toBe(false);
});

it("lets VoiceOver scroll the page by most of a screen, and never clicks where VoiceOver activates", () => {
  const view = driven();
  const props = nativeProps.get(view.page())!;
  expect(props.accessibilityActions).toEqual([
    { name: "scrollUp", label: "Scroll Up" },
    { name: "scrollDown", label: "Scroll Down" },
  ]);
  act(() => (props.onAccessibilityAction as (event: object) => void)({ nativeEvent: { actionName: "scrollDown" } }));
  act(() => (props.onAccessibilityAction as (event: object) => void)({ nativeEvent: { actionName: "scrollUp" } }));
  expect(view.scrolls).toEqual([
    [{ x: 393, y: 283 }, 0, 509.4],
    [{ x: 393, y: 283 }, 0, -509.4],
  ]);
  act(() => (props.onAccessibilityTap as () => void)());
  expect(view.taps).toEqual([]);
});
