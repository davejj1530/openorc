import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameMeasurement } from "./frame-measurement";
import { beginMainThreadMeasurement } from "./main-thread-measurement";

describe("benchmark main-thread measurement", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not treat a slow display cadence as an unresponsive main thread", () => {
    const finish = beginMainThreadMeasurement();
    const frames = new FrameMeasurement();
    frames.begin(now);
    for (let tick = 1; tick <= 80; tick++) {
      now = tick * 4;
      vi.advanceTimersByTime(4);
      if (tick % 8 === 0) frames.frame(now);
    }
    expect(frames.finish(now).longFramesTotal).toBe(10);
    expect(finish()).toMatchObject({ durationMs: 320, stallsTotal: 0, longestGapMs: 4 });
  });

  it("counts a blocked main thread with the existing strict 20 ms threshold", () => {
    const finish = beginMainThreadMeasurement();
    now = 20;
    vi.advanceTimersByTime(4);
    now = 41;
    vi.advanceTimersByTime(4);
    now = 101;
    vi.advanceTimersByTime(4);
    expect(finish()).toMatchObject({ stallsTotal: 2, longestGapMs: 60 });
  });

  it("includes a freeze immediately before the measurement ends", () => {
    const finish = beginMainThreadMeasurement();
    now = 4;
    vi.advanceTimersByTime(4);
    now = 64;
    expect(finish()).toMatchObject({ durationMs: 64, stallsTotal: 1, longestGapMs: 60 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops sampling between phases and resets the next workload", () => {
    const first = beginMainThreadMeasurement();
    now = 60;
    expect(first().stallsTotal).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    now = 3000;
    const second = beginMainThreadMeasurement();
    now += 4;
    vi.advanceTimersByTime(4);
    expect(second()).toMatchObject({ durationMs: 4, stallsTotal: 0, longestGapMs: 4 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
