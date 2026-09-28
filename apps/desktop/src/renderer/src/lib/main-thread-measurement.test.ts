import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginMainThreadMeasurement } from "./main-thread-measurement";

function task(startTime: number, duration: number): PerformanceEntry {
  return { entryType: "longtask", name: "self", startTime, duration, toJSON: () => ({}) };
}

describe("benchmark main-thread measurement", () => {
  let now: number;
  let queued: PerformanceEntry[];
  let deliver: (entries: PerformanceEntry[]) => void;
  const disconnect = vi.fn();
  const observe = vi.fn();
  beforeEach(() => {
    now = 100;
    queued = [];
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        static supportedEntryTypes = ["longtask"];
        constructor(callback: PerformanceObserverCallback) {
          deliver = (entries) => callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
        }
        observe = observe;
        disconnect = disconnect;
        takeRecords = () => queued.splice(0);
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("does not infer busy tasks from elapsed wall time and installs no polling timer", async () => {
    const finish = beginMainThreadMeasurement();
    expect(observe).toHaveBeenCalledWith({ type: "longtask" });
    expect(vi.getTimerCount()).toBe(0);
    now += 1000;
    const result = finish();
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ durationMs: 1000, longTasksTotal: 0, longestTaskMs: 0, totalBlockingTimeMs: 0 });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("collects delivered and pending tasks once and excludes tasks outside the phase", async () => {
    const finish = beginMainThreadMeasurement();
    deliver([task(20, 60), task(200, 60)]);
    queued.push(task(400, 90));
    now = 1000;
    const result = finish();
    // A task queued during the drain must not enter the finished phase.
    queued.push(task(1100, 80));
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ durationMs: 900, longTasksTotal: 2, longestTaskMs: 90, totalBlockingTimeMs: 50 });
  });

  it("drains the final task even when it began before measurement in the same callback", async () => {
    const finish = beginMainThreadMeasurement();
    now = 170;
    const result = finish();
    expect(disconnect).not.toHaveBeenCalled();
    queued.push(task(99, 72));
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ longTasksTotal: 1, longestTaskMs: 72 });
  });

  it("does not carry tasks into a later phase", async () => {
    const finish = beginMainThreadMeasurement();
    queued.push(task(110, 60));
    now = 200;
    const first = finish();
    await vi.runAllTimersAsync();
    expect((await first).longTasksTotal).toBe(1);
    now = 300;
    const finishNext = beginMainThreadMeasurement();
    now = 400;
    const next = finishNext();
    await vi.runAllTimersAsync();
    expect((await next).longTasksTotal).toBe(0);
  });

  it("fails explicitly when Chromium cannot provide the required measurement", () => {
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        static supportedEntryTypes: string[] = [];
      },
    );
    expect(() => beginMainThreadMeasurement()).toThrow("requires Chromium longtask measurements");
  });
});
