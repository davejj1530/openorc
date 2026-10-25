import { router } from "expo-router";
import { useEffect } from "react";
import { useFrameCallback, useSharedValue } from "react-native-reanimated";
import { isLive } from "@openorc/client";
import { client, link } from "../client";
import { markThreadOpening, percentile, perfEnabled, perfScenario, perfStepMs, perfThread, perfTurns, report, startFrames, stopFrames, takeArrivals, takeMounts, transcriptList } from "./perf-probe";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the thread a performance run names once the link is up, so the time measured is the Mac's answer, not the connect. */
export function usePerfAutoOpen(): void {
  useEffect(() => {
    const threadId = perfThread();
    if (!threadId) return;
    let opened = false;
    const open = () => {
      if (opened || link.getState().kind !== "connected") return;
      opened = true;
      // A beat for Home to settle, as a person would take before tapping.
      setTimeout(() => {
        markThreadOpening(threadId);
        router.push({ pathname: "/thread/[id]", params: { id: threadId } });
      }, 1500);
    };
    open();
    return link.subscribe(open);
  }, []);
}

/** Whether some run has a block still live of the kinds a scenario samples. */
function liveIn(kinds: readonly string[]): boolean {
  for (const run of client.runs.snapshot().values())
    if (run.blocks.some((block) => kinds.includes(block.kind) && isLive(block) && (block.kind !== "message" || block.role === "assistant"))) return true;
  return false;
}
const streaming = () => liveIn(["message"]);
/** Reasoning or a call under way: the work a turn does before its reply. */
const working = () => liveIn(["thinking", "tool"]);

interface Sampler {
  begin(): void;
  finish(scenario: string, extra?: Record<string, unknown>): void;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** What one sampled stretch came to: JS work per published frame, the JS thread's frame pacing, the UI thread's frames. */
function summary({ total: frames, records, render }: ReturnType<typeof stopFrames>, jsGaps: number[], ui: number[]) {
  const typical = percentile(ui, 50);
  return {
    jsFrames: frames.length,
    jsMedianMs: round(percentile(frames, 50)),
    jsP95Ms: round(percentile(frames, 95)),
    jsMaxMs: round(Math.max(0, ...frames)),
    recordsMedianMs: round(percentile(records, 50)),
    renderMedianMs: round(percentile(render, 50)),
    renderP95Ms: round(percentile(render, 95)),
    jsPaceMedianMs: round(percentile(jsGaps, 50)),
    jsPaceP95Ms: round(percentile(jsGaps, 95)),
    jsLateFrames: jsGaps.filter((ms) => ms > typical * 1.5).length,
    uiFrames: ui.length,
    uiMedianMs: round(typical),
    uiDropped: ui.filter((ms) => ms > typical * 1.5).length,
    uiWorst: [...ui]
      .sort((a, b) => b - a)
      .slice(0, 8)
      .map(round),
    markdownMounts: takeMounts("markdown"),
    frameMounts: takeMounts("frame"),
  };
}

/** Up through the whole history a screen at a time, loading older pages on the way, then back down, each sampled. */
async function scrollRun(sampler: Sampler, cancelled: () => boolean, name = "scroll") {
  await wait(2500);
  const list = transcriptList();
  if (!list || cancelled()) return;
  sampler.begin();
  let steps = 0;
  // At the top for a second with nothing older arriving: the whole history is loaded.
  for (let atTop = 0; steps < 400 && !cancelled() && atTop < 4; steps++) {
    const { scroll: at } = list.getState();
    atTop = at <= 1 ? atTop + 1 : 0;
    void list.scrollToOffset({ offset: Math.max(0, at - 600), animated: true });
    await wait(perfStepMs());
  }
  sampler.finish(`${name}-up`, { steps, items: list.getState().data.length });
  await wait(1500);
  sampler.begin();
  for (steps = 0; steps < 400 && !cancelled() && !list.getState().isAtEnd; steps++) {
    void list.scrollToOffset({ offset: list.getState().scroll + 600, animated: true });
    await wait(perfStepMs());
  }
  sampler.finish(name, { steps, items: list.getState().data.length, contentLength: Math.round(list.getState().contentLength) });
}

/** Watches `turns` turns arrive while the thread is open, then scrolls as `scrollRun` does: rows that arrived live. */
async function liveScrollRun(sampler: Sampler, cancelled: () => boolean, turns: number) {
  const prompts = () => (transcriptList()?.getState().data as { kind: string }[] | undefined)?.filter((row) => row.kind === "prompt").length ?? 0;
  await wait(2500);
  const start = prompts();
  takeArrivals();
  while (!cancelled() && (prompts() < start + turns || liveIn(["message", "thinking", "tool"]))) await wait(500);
  report("live-arrivals", { turns, rows: takeArrivals() });
  takeMounts("markdown");
  takeMounts("frame");
  await scrollRun(sampler, cancelled, "live-scroll");
}

/** Samples from the moment `live` turns true to half a second after it last was: a reply streaming, or a turn's work. */
function streamRun(sampler: Sampler, name: string, live: () => boolean): () => void {
  let started = false;
  let quietSince = 0;
  const timer = setInterval(() => {
    const now = live();
    if (now && !started) {
      started = true;
      sampler.begin();
    }
    if (!started) return;
    if (now) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince > 500) {
      clearInterval(timer);
      sampler.finish(name);
    }
  }, 50);
  return () => clearInterval(timer);
}

/**
 * Drives a performance run on the open thread and reports what it measured: JS work per frame (median, p95), the JS
 * thread's pacing and the UI thread's frames, while scrolling the whole history or while a reply streams.
 */
export function PerfProbe() {
  const sampling = useSharedValue(false);
  const intervals = useSharedValue<number[]>([]);
  useFrameCallback(({ timeSincePreviousFrame }) => {
    "worklet";
    if (sampling.value && timeSincePreviousFrame !== null)
      intervals.modify((list) => {
        "worklet";
        list.push(timeSincePreviousFrame);
        return list;
      });
  });

  useEffect(() => {
    if (!perfEnabled()) return;
    let cancelled = false;
    // The JS thread's own frame pacing: a frame it was too busy to start on time shows as a long gap here.
    let jsGaps: number[] = [];
    let pacing = 0;
    const pace = (last: number) => {
      pacing = requestAnimationFrame((now) => {
        jsGaps.push(now - last);
        pace(now);
      });
    };
    const sampler: Sampler = {
      begin() {
        intervals.value = [];
        sampling.value = true;
        takeMounts("markdown");
        takeMounts("frame");
        startFrames();
        jsGaps = [];
        pace(performance.now());
      },
      finish(scenario, extra = {}) {
        sampling.value = false;
        cancelAnimationFrame(pacing);
        report(scenario, { ...summary(stopFrames(), jsGaps, intervals.value), ...extra });
      },
    };
    const scenario = perfScenario();
    if (scenario === "scroll") void scrollRun(sampler, () => cancelled);
    if (scenario === "live-scroll") void liveScrollRun(sampler, () => cancelled, perfTurns());
    const samplers: Record<string, () => boolean> = { stream: streaming, work: working };
    const live = samplers[scenario];
    const stop = live ? streamRun(sampler, scenario, live) : undefined;
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [intervals, sampling]);
  return null;
}
