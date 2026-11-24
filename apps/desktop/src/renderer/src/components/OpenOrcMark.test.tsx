import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenOrcMark, WorkingCube } from "./OpenOrcMark";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const lit = () => document.documentElement.dataset["litFace"];

it("moves the light around every working cube on the document's clock, so cubes that appear later turn in step", () => {
  vi.setSystemTime(0);
  const first = render(<WorkingCube />);
  expect(lit()).toBe("top");
  vi.advanceTimersByTime(624);
  expect(lit()).toBe("right");
  // A cube that appears mid-turn takes the face the clock is on, not a turn of its own.
  vi.advanceTimersByTime(400);
  const second = render(<OpenOrcMark size={24} working />);
  expect(lit()).toBe("right");
  vi.advanceTimersByTime(400);
  expect(lit()).toBe("left");
  vi.advanceTimersByTime(800);
  expect(lit()).toBe("top");
  first.unmount();
  expect(lit()).toBe("top");
  second.unmount();
  expect(lit()).toBeUndefined();
});

it("leaves the clock alone for a mark at rest", () => {
  render(<OpenOrcMark size={16} />);
  expect(lit()).toBeUndefined();
});
