import type { FormatReply, FormatRequest } from "./formatter-host.js";
import { FORMAT_TIMEOUT_MS, type BundledFormatter } from "./services/file-format.js";

/** The parts of a worker thread the client uses, so tests can stand in for one. */
export interface FormatWorker {
  postMessage(request: FormatRequest): void;
  on(event: "message", listener: (reply: FormatReply) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  unref(): void;
  terminate(): Promise<number>;
}

interface Pending {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The bundled Prettier in a worker thread that serveFormatter answers in, so formatting a large file never stalls the
 * core. The thread starts on first use and never keeps the process alive. A format that runs past the timeout ends the
 * thread and fails, so one pathological file can't wedge every later save, and the next format starts a new thread.
 */
export class WorkerFormatter implements BundledFormatter {
  private worker: FormatWorker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly spawn: () => FormatWorker,
    private readonly timeoutMs = FORMAT_TIMEOUT_MS,
  ) {}

  format(text: string, filepath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const worker = this.start();
      const id = this.nextId++;
      const timer = setTimeout(() => this.stop(worker, new Error(`it took longer than ${this.timeoutMs / 1000} seconds and was stopped`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, text, filepath });
    });
  }

  private start(): FormatWorker {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    worker.unref();
    worker.on("message", (reply) => this.answer(reply));
    worker.on("error", (error) => this.stop(worker, error));
    worker.on("exit", () => this.stop(worker, new Error("it stopped unexpectedly")));
    this.worker = worker;
    return worker;
  }

  private answer(reply: FormatReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if ("error" in reply) pending.reject(new Error(reply.error));
    else pending.resolve(reply.text);
  }

  /** Ends the thread and fails everything it was formatting. A thread already replaced is left alone. */
  private stop(worker: FormatWorker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    void worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
