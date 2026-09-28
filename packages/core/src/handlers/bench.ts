import { Db, LedgerWriter } from "@openorc/db";
import { seedBenchThread } from "../bench-thread.js";
import { BenchGenerator } from "../bench.js";
import { FrameCoalescer } from "../frames.js";
import { type Transport } from "../transport.js";
import type { Handlers } from "./types.js";
function requireBenchmarks(enabled: boolean): void {
  if (!enabled) throw new Error("Benchmarks are only available in development and QA builds.");
}

type Dependencies = {
  benchmarks: boolean;
  frames: Pick<FrameCoalescer, "framesSent" | "eventsSent" | "flush">;
  bench: Pick<BenchGenerator, "start" | "startedAt" | "stop">;
  db: Db;
  ledger: LedgerWriter;
  transport: Transport;
};

export function createBenchHandlers({ benchmarks, frames, bench, db, ledger, transport }: Dependencies): Pick<Handlers, "bench.start" | "bench.seedThread" | "bench.stop"> {
  return {
    "bench.start": ({ runs: n, eventsPerSecond, durationMs, runIds }) => {
      requireBenchmarks(benchmarks);
      const before = { frames: frames.framesSent, events: frames.eventsSent };
      bench.start(
        n,
        eventsPerSecond,
        durationMs,
        () => {
          frames.flush();
          transport.push({
            type: "bench.done",
            eventsSent: frames.eventsSent - before.events,
            framesSent: frames.framesSent - before.frames,
            durationMs: Date.now() - bench.startedAt,
          });
        },
        runIds,
      );
      return null;
    },
    "bench.seedThread": () => {
      requireBenchmarks(benchmarks);
      return seedBenchThread(db, ledger);
    },
    "bench.stop": () => {
      requireBenchmarks(benchmarks);
      bench.stop();
      return null;
    },
  };
}
