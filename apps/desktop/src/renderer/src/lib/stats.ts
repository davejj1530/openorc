import { create } from "zustand";
import { core } from "./rpc";
import { FrameMeasurement } from "./frame-measurement";
import { beginMainThreadMeasurement } from "./main-thread-measurement";

export interface SecondSample {
  events: number;
  frames: number;
  longFrames: number;
}

interface StatsState {
  connected: boolean;
  mcpPort: number | null;
  eventsReceived: number;
  framesReceived: number;
  last: SecondSample;
  samples: SecondSample[];
  benchResult: { eventsSent: number; framesSent: number; durationMs: number } | null;
  logs: string[];
}

/** Renderer-side counters for the diagnostics screen and the CI autorun. */
export const useStats = create<StatsState>(() => ({
  connected: false,
  mcpPort: null,
  eventsReceived: 0,
  framesReceived: 0,
  last: { events: 0, frames: 0, longFrames: 0 },
  samples: [],
  benchResult: null,
  logs: [],
}));

let windowEvents = 0;
let windowFrames = 0;
let windowLong = 0;
let eventsReceived = 0;
let framesReceived = 0;
const benchmarkFrames = new FrameMeasurement();
let finishMainThread: ReturnType<typeof beginMainThreadMeasurement> | null = null;
export function beginBenchmarkFrames() {
  finishMainThread?.();
  benchmarkFrames.begin(performance.now());
  finishMainThread = beginMainThreadMeasurement();
}
export function finishBenchmarkFrames() {
  if (!finishMainThread) throw new Error("No benchmark measurement is active");
  const mainThread = finishMainThread();
  finishMainThread = null;
  return { ...benchmarkFrames.finish(performance.now()), mainThread };
}

/** Totals up to the last frame; the store only catches up once a second. */
export const receivedTotals = () => ({ eventsReceived, framesReceived });

let started = false;

/** Starts counting. It watches every frame, so only the diagnostics screen and the benchmarks start it; it then runs until the window closes. */
export function startStats(): void {
  if (started) return;
  started = true;
  core.onReady(({ mcpPort }) => useStats.setState({ connected: true, mcpPort }));
  // Counted here, published with the per-second sample: a store update per frame re-renders every subscriber per
  // frame, which on the diagnostics screen cost several times the bridge work the benchmark measures.
  core.onFrame((frame) => {
    windowFrames += 1;
    windowEvents += frame.events.length;
    framesReceived += 1;
    eventsReceived += frame.events.length;
  });
  core.onBenchDone((r) => useStats.setState({ benchResult: r }));
  core.onLog((l) => useStats.setState((s) => ({ logs: [...s.logs.slice(-199), `[${l.level}] ${l.message}`] })));

  let last = performance.now();
  const tick = (now: number) => {
    benchmarkFrames.frame(now);
    if (now - last > 20) windowLong += 1;
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  setInterval(() => {
    const sample = { events: windowEvents, frames: windowFrames, longFrames: windowLong };
    useStats.setState((s) => ({ last: sample, samples: [...s.samples.slice(-119), sample], eventsReceived, framesReceived }));
    windowEvents = 0;
    windowFrames = 0;
    windowLong = 0;
  }, 1000);
}
