import { expect, it } from "vitest";
import { groundOpacity, swipeCloses } from "./viewer-gestures";

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
