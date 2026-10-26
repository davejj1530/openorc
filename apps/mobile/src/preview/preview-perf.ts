import { Settings } from "react-native";
import { percentile, perfEnabled, perfScenario } from "../thread/perf-probe";

/** `-openorcPerfScenario preview`: the thread's Preview, watched and sampled for `-openorcPerfSeconds` (60 by default). */
export const isPreviewScenario = (scenario: string): boolean => scenario === "preview";
export const previewScenario = (): boolean => perfEnabled() && isPreviewScenario(perfScenario());
export const perfSeconds = (): number => Number(Settings.get("openorcPerfSeconds") ?? 60);

/** JS work per frame while measuring: its bytes into a `data:` URI, then the render that puts it on screen. */
let work: { convert: number[]; render: number[]; bytes: number; pending: boolean; renderStart: number } | null = null;

/** Times one frame's conversion. Free unless measuring. */
export function timeConvert(bytes: Uint8Array, convert: () => string): string {
  if (!work) return convert();
  const start = performance.now();
  const uri = convert();
  work.convert.push(performance.now() - start);
  work.bytes += bytes.length;
  work.pending = true;
  return uri;
}

/** The screen starts the render a new frame asked for. */
export function markFrameRender(): void {
  if (!work?.pending) return;
  work.pending = false;
  work.renderStart = performance.now();
}

/** The frame view committed the new frame. */
export function markFrameShown(): void {
  if (!work?.renderStart) return;
  work.render.push(performance.now() - work.renderStart);
  work.renderStart = 0;
}

export function startFrameWork(): void {
  if (perfEnabled()) work = { convert: [], render: [], bytes: 0, pending: false, renderStart: 0 };
}

const round = (value: number) => Math.round(value * 100) / 100;

export function stopFrameWork(): Record<string, number> {
  const done = work ?? { convert: [], render: [], bytes: 0 };
  work = null;
  const totals = done.render.map((render, index) => render + (done.convert[index] ?? 0));
  return {
    frames: done.convert.length,
    kbPerFrame: round(done.bytes / 1024 / Math.max(1, done.convert.length)),
    convertMedianMs: round(percentile(done.convert, 50)),
    convertP95Ms: round(percentile(done.convert, 95)),
    renderMedianMs: round(percentile(done.render, 50)),
    renderP95Ms: round(percentile(done.render, 95)),
    perFrameP95Ms: round(percentile(totals, 95)),
    perFrameMaxMs: round(Math.max(0, ...totals)),
  };
}
