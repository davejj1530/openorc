import type { LegendListRef } from "@legendapp/list/react-native";
import type { RefObject } from "react";
import { Settings } from "react-native";

/**
 * Measurements for performance runs, reported to the unified log when the app is launched with
 * `xcrun simctl launch booted app.openorc.mobile -openorcPerfReport 1` (plus `-openorcPerfThread <id>` and
 * `-openorcPerfScenario open|scroll|stream` to drive a run). React Native writes console.info there in Release builds
 * too. Off otherwise: nothing is timed or kept.
 */
let enabled: boolean | null = null;
export const perfEnabled = (): boolean => (enabled ??= Boolean(Settings.get("openorcPerfReport")));
export const perfThread = (): string | null => (perfEnabled() ? ((Settings.get("openorcPerfThread") as string | undefined) ?? null) : null);
export const perfScenario = (): string => (Settings.get("openorcPerfScenario") as string | undefined) ?? "open";
/** For `live-scroll`: how many turns to watch arrive before scrolling (`-openorcPerfTurns <n>`). */
export const perfTurns = (): number => Number(Settings.get("openorcPerfTurns") ?? 10);
/** For the scroll scenarios: how long each screen-high step takes, scrolling included (`-openorcPerfStepMs <ms>`). */
export const perfStepMs = (): number => Number(Settings.get("openorcPerfStepMs") ?? 300);

export function report(event: string, values: Record<string, unknown>): void {
  console.info(`openorc-perf ${JSON.stringify({ event, ...values })}`);
}

/**
 * Heavy native views mounted while measuring: a Markdown view costs a native view, a parse and a measure; a
 * visualization's web view costs a WebKit view and its page. Free unless measuring.
 */
const mounts = { markdown: 0, frame: 0 };
export type HeavyView = keyof typeof mounts;

export function countMount(view: HeavyView): void {
  if (perfEnabled()) mounts[view]++;
}
/** Views of that kind mounted since the last call. */
export function takeMounts(view: HeavyView): number {
  const count = mounts[view];
  mounts[view] = 0;
  return count;
}

let arrivals = 0;
/** Counts rows that rose in live. */
export function countArrivals(count: number): void {
  if (perfEnabled()) arrivals += count;
}
/** Rows that rose in since the last call. */
export function takeArrivals(): number {
  const count = arrivals;
  arrivals = 0;
  return count;
}

const opening = new Map<string, number>();

/** The tap that opens a thread. */
export function markThreadOpening(threadId: string): void {
  if (perfEnabled()) opening.set(threadId, performance.now());
}

/** The thread's first rows are on screen: from the tap to the frame after they rendered. */
export function reportThreadOpened(threadId: string, blocks: number): void {
  const start = opening.get(threadId);
  if (start === undefined) return;
  opening.delete(threadId);
  requestAnimationFrame(() => report("thread-open", { ms: Math.round(performance.now() - start), blocks }));
}

/**
 * JS work per animation frame while sampling: the records that arrived since the last frame (decrypt, parse, reduce)
 * plus the frame's publish and the React render and commit it flushes.
 */
let pendingMs = 0;
let frameMs: number[] | null = null;
/** The same frames split in two: the records' share and the publish-and-render share. */
let recordMs: number[] = [];
let renderMs: number[] = [];

/** Times one received record's handling, from the socket's message event through the store. */
export function timeRecord(handle: () => void): void {
  const start = performance.now();
  handle();
  pendingMs += performance.now() - start;
}

/** Wraps a frame callback so its publish and the render it causes count toward this frame. */
export function timeFrame(callback: () => void): () => void {
  if (!perfEnabled()) return callback;
  return () => {
    const start = performance.now();
    callback();
    // React flushes a store update in a microtask queued during the callback; this one runs after it.
    queueMicrotask(() => {
      const render = performance.now() - start;
      if (frameMs) {
        frameMs.push(pendingMs + render);
        recordMs.push(pendingMs);
        renderMs.push(render);
      }
      pendingMs = 0;
    });
  };
}

export function startFrames(): void {
  pendingMs = 0;
  frameMs = [];
  recordMs = [];
  renderMs = [];
}

export function stopFrames(): { total: number[]; records: number[]; render: number[] } {
  const frames = { total: frameMs ?? [], records: recordMs, render: renderMs };
  frameMs = null;
  return frames;
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** The open thread's list, for scripted scrolls in performance runs. */
let list: RefObject<LegendListRef | null> | null = null;
export function holdTranscriptList(ref: RefObject<LegendListRef | null>): () => void {
  list = ref;
  return () => {
    if (list === ref) list = null;
  };
}
export const transcriptList = (): LegendListRef | null => list?.current ?? null;
