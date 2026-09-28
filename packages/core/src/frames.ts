import type { AgentEvent, Frame } from "@openorc/protocol";

/**
 * Collects events per run and flushes at most one frame per run per tick, so
 * the renderer sees one structured-clone message per run per animation frame
 * regardless of how fast the agent talks.
 */
export class FrameCoalescer {
  private readonly buffers = new Map<string, AgentEvent[]>();
  private readonly seq = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  framesSent = 0;
  eventsSent = 0;

  constructor(
    private readonly send: (frame: Frame) => void,
    private readonly intervalMs = 16,
  ) {}

  push(ev: AgentEvent): void {
    let buf = this.buffers.get(ev.runId);
    if (!buf) {
      buf = [];
      this.buffers.set(ev.runId, buf);
    }
    buf.push(ev);
    if (!this.timer) this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    let pending = false;
    for (const [runId, events] of this.buffers) {
      if (events.length === 0) continue;
      const seq = (this.seq.get(runId) ?? 0) + 1;
      this.seq.set(runId, seq);
      this.send({ runId, seq, events });
      this.framesSent += 1;
      this.eventsSent += events.length;
      this.buffers.set(runId, []);
      pending = true;
    }
    if (!pending && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
