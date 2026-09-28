import type { AgentEvent } from "@openorc/protocol";

/**
 * Synthetic agent traffic for the bridge benchmark: `runs` fake agents that
 * together produce `eventsPerSecond`, as streaming text with a new message
 * block every 40 deltas so the transcript grows in both length and height.
 */
export class BenchGenerator {
  private timer: NodeJS.Timeout | null = null;
  private counters = new Map<string, number>();
  eventsSent = 0;
  startedAt = 0;

  constructor(private readonly emit: (ev: AgentEvent) => void) {}

  start(runs: number, eventsPerSecond: number, durationMs: number, onDone: () => void, targets?: string[]): void {
    this.stop();
    this.eventsSent = 0;
    this.startedAt = Date.now();
    const runIds = targets?.length ? targets : Array.from({ length: runs }, (_, i) => `bench-${i + 1}`);
    for (const id of runIds) {
      this.counters.set(id, 0);
      this.emit({ type: "session.started", runId: id, ts: Date.now(), agent: "claude", externalSessionId: id, model: "bench" });
    }
    const tickMs = 4;
    const perTick = Math.max(1, Math.round((eventsPerSecond * tickMs) / 1000));
    let r = 0;
    this.timer = setInterval(() => {
      if (Date.now() - this.startedAt >= durationMs) {
        for (const id of runIds) {
          this.emit({ type: "session.completed", runId: id, ts: Date.now(), status: "success", durationMs: Date.now() - this.startedAt });
        }
        this.stop();
        onDone();
        return;
      }
      for (let i = 0; i < perTick; i += 1) {
        const runId = runIds[r % runIds.length] as string;
        r += 1;
        const n = (this.counters.get(runId) ?? 0) + 1;
        this.counters.set(runId, n);
        const messageId = `${runId}-m${Math.floor(n / 40)}`;
        if (n % 40 === 1) {
          this.emit({ type: "tool.started", runId, ts: Date.now(), toolCallId: `${messageId}-t`, name: "Read", input: { path: `src/file${n}.ts` }, parentToolCallId: null });
          this.emit({ type: "tool.completed", runId, ts: Date.now(), toolCallId: `${messageId}-t`, name: "Read", output: "ok", isError: false });
        }
        this.emit({ type: "message.delta", runId, ts: Date.now(), messageId, role: "assistant", text: WORDS[n % WORDS.length] as string });
        this.eventsSent += 1;
      }
    }, tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const WORDS = [
  "Reading ",
  "the ",
  "task ",
  "spec ",
  "and ",
  "checking ",
  "the ",
  "ledger ",
  "for ",
  "prior ",
  "attempts. ",
  "Found ",
  "a ",
  "lesson ",
  "about ",
  "vitest ",
  "pools, ",
  "applying ",
  "it ",
  "now.\n",
  "Editing ",
  "src/export.ts ",
  "to ",
  "add ",
  "the ",
  "CSV ",
  "writer ",
  "with ",
  "escaping ",
  "for ",
  "quotes ",
  "and ",
  "newlines. ",
];
