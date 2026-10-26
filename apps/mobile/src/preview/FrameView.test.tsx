// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
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
