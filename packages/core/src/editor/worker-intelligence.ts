import type { EditorResult } from "@openorc/protocol";
import type { IntelligenceMessage, IntelligenceReply } from "./intelligence-host.js";
import type { IntelligenceRequest } from "./typescript-intelligence.js";

export interface IntelligenceEngine {
  query(input: IntelligenceRequest): Promise<EditorResult>;
  close(): Promise<void>;
}

export interface IntelligenceWorker {
  postMessage(message: IntelligenceMessage): void;
  on(event: "message", listener: (reply: IntelligenceReply) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  unref(): void;
  terminate(): Promise<number>;
}

interface Pending {
  resolve: (result: EditorResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Lazy, restartable and idle-reaped: expensive projects cannot block the core or stay resident after editing ends. */
export class WorkerIntelligence implements IntelligenceEngine {
  private worker: IntelligenceWorker | null = null;
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private idle: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly spawn: () => IntelligenceWorker,
    private readonly timeout = 20_000,
    private readonly idleMs = 60_000,
  ) {}

  query(request: IntelligenceRequest): Promise<EditorResult> {
    if (this.closed) return Promise.reject(new Error("Code intelligence has shut down."));
    if (this.pending.size >= 32) return Promise.reject(new Error("Code intelligence is busy. Try again in a moment."));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const worker = this.start();
      const id = ++this.next;
      const timer = setTimeout(() => void this.stop(worker, new Error("Code intelligence took too long and was restarted.")), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, request });
      } catch (error) {
        void this.stop(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private start(): IntelligenceWorker {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.worker = worker;
    worker.on("message", (reply) => this.answer(reply));
    worker.on("error", (error) => void this.stop(worker, error));
    worker.on("exit", () => void this.stop(worker, new Error("Code intelligence stopped unexpectedly.")));
    worker.unref();
    return worker;
  }

  private answer(reply: IntelligenceReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if ("error" in reply) pending.reject(new Error(reply.error));
    else pending.resolve(reply.result);
    if (!this.pending.size && this.worker) {
      const worker = this.worker;
      this.idle = setTimeout(() => void this.stop(worker, new Error("The editor is idle.")), this.idleMs);
      this.idle.unref();
    }
  }

  private async stop(worker: IntelligenceWorker, error: Error): Promise<void> {
    if (this.worker !== worker) return;
    this.worker = null;
    clearTimeout(this.idle);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    await worker.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.worker) await this.stop(this.worker, new Error("Code intelligence has shut down."));
  }
}
