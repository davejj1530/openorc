import { expect, it } from "vitest";
import { fitFrame, framePoint } from "./frame-fit";

it("fits a wide frame to the view's width, at its top", () => {
  expect(fitFrame({ width: 390, height: 700 }, { width: 786, height: 566 })).toEqual({ left: 0, width: 390, height: 281 });
});

it("fits a frame taller than the view to its height, centered, so nothing scrolls the picture at its whole size", () => {
  expect(fitFrame({ width: 390, height: 600 }, { width: 786, height: 1572 })).toEqual({ left: 45, width: 300, height: 600 });
});

it("reads a point on the picture in the frame's own pixels, and nothing off the picture", () => {
  const wide = { left: 0, width: 390, height: 281 };
  expect(framePoint({ x: 195, y: 140.5 }, wide, { width: 786, height: 566 })).toEqual({ x: 393, y: 283 });
  expect(framePoint({ x: 0, y: 0 }, wide, { width: 786, height: 566 })).toEqual({ x: 0, y: 0 });
  expect(framePoint({ x: 195, y: 300 }, wide, { width: 786, height: 566 })).toBeNull();
  const tall = { left: 45, width: 300, height: 600 };
  expect(framePoint({ x: 195, y: 300 }, tall, { width: 786, height: 1572 })).toEqual({ x: 393, y: 786 });
  expect(framePoint({ x: 30, y: 300 }, tall, { width: 786, height: 1572 })).toBeNull();
});
