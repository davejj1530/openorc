/** Counts frame gaps during one workload, independent of the diagnostics' one-second sampling windows. */
export class FrameMeasurement {
  private active: { startedAt: number; lastFrame: number; longFramesTotal: number; longestFrameMs: number } | null = null;

  begin(now: number): void {
    this.active = { startedAt: now, lastFrame: now, longFramesTotal: 0, longestFrameMs: 0 };
  }

  frame(now: number): void {
    const active = this.active;
    if (!active || now < active.lastFrame) return;
    if (now - active.lastFrame > 20) active.longFramesTotal++;
    active.longestFrameMs = Math.max(active.longestFrameMs, now - active.lastFrame);
    active.lastFrame = now;
  }

  finish(now: number): { durationMs: number; longFramesTotal: number; longestFrameMs: number } {
    const active = this.active;
    if (!active) throw new Error("No benchmark frame measurement is active");
    this.frame(now);
    this.active = null;
    return { durationMs: now - active.startedAt, longFramesTotal: active.longFramesTotal, longestFrameMs: Math.round(active.longestFrameMs) };
  }
}
