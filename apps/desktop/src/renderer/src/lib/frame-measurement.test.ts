import { describe, expect, it } from "vitest";
import { FrameMeasurement } from "./frame-measurement";

describe("benchmark frame measurement", () => {
  it("excludes idle frames outside the requested workload, including partial sample seconds", () => {
    const frames = new FrameMeasurement();
    frames.frame(30);
    frames.frame(60);
    frames.begin(70);
    frames.frame(80);
    frames.frame(96);
    frames.frame(112);
    const result = frames.finish(120);
    frames.frame(160);
    frames.frame(200);
    expect(result).toEqual({ durationMs: 50, longFramesTotal: 0, longestFrameMs: 16 });
  });

  it("keeps the 20 ms threshold and resets between workload phases", () => {
    const frames = new FrameMeasurement();
    frames.begin(100);
    frames.frame(95); // rAF's timestamp can precede a measurement started mid-frame.
    frames.frame(120);
    frames.frame(141);
    expect(frames.finish(141).longFramesTotal).toBe(1);
    frames.begin(200);
    frames.frame(216);
    expect(frames.finish(220).longFramesTotal).toBe(0);
  });
});
