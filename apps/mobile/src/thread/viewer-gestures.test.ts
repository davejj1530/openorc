import { expect, it } from "vitest";
import { doubleTapRect, groundOpacity, swipeCloses } from "./viewer-gestures";

it("closes on a long or a quick swipe down, and springs back from a short slow one or one upward", () => {
  expect(swipeCloses(121, 0)).toBe(true);
  expect(swipeCloses(40, 1200)).toBe(true);
  expect(swipeCloses(60, 300)).toBe(false);
  expect(swipeCloses(-200, -2000)).toBe(false);
});

it("dims the ground as the image goes down, never as it goes up", () => {
  expect(groundOpacity(0, 800)).toBe(1);
  expect(groundOpacity(-100, 800)).toBe(1);
  expect(groundOpacity(240, 800)).toBeCloseTo(0.5);
  expect(groundOpacity(2000, 800)).toBe(0);
});

it("zooms twice as close around the tapped point, kept inside the image, and back out when zoomed", () => {
  const size = { width: 400, height: 800 };
  expect(doubleTapRect({ x: 200, y: 400 }, size, false)).toEqual({ x: 100, y: 200, width: 200, height: 400 });
  expect(doubleTapRect({ x: 10, y: 790 }, size, false)).toEqual({ x: 0, y: 400, width: 200, height: 400 });
  expect(doubleTapRect({ x: 10, y: 790 }, size, true)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
});
