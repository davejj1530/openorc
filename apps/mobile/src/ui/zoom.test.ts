import { expect, it } from "vitest";
import { doubleTapRect } from "./zoom";

it("zooms twice as close around the tapped point, kept inside the image, and back out when zoomed", () => {
  const size = { width: 400, height: 800 };
  expect(doubleTapRect({ x: 200, y: 400 }, size, false)).toEqual({ x: 100, y: 200, width: 200, height: 400 });
  expect(doubleTapRect({ x: 10, y: 790 }, size, false)).toEqual({ x: 0, y: 400, width: 200, height: 400 });
  expect(doubleTapRect({ x: 10, y: 790 }, size, true)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
});

it("zooms twice as close into content taller or shorter than the view, by the view's size, and back out to the page's top", () => {
  const page = { width: 400, height: 2000 };
  const view = { width: 400, height: 700 };
  expect(doubleTapRect({ x: 200, y: 1000 }, page, false, view)).toEqual({ x: 100, y: 825, width: 200, height: 350 });
  expect(doubleTapRect({ x: 390, y: 1990 }, page, false, view)).toEqual({ x: 200, y: 1650, width: 200, height: 350 });
  expect(doubleTapRect({ x: 390, y: 1990 }, page, true, view)).toEqual({ x: 0, y: 0, width: 400, height: 700 });
  // A short page zooms back out to its top, where it sits, not to the middle of the view.
  expect(doubleTapRect({ x: 200, y: 100 }, { width: 400, height: 300 }, true, view)).toEqual({ x: 0, y: 0, width: 400, height: 700 });
});
