import type { EmbedCall, EmbedReply, EmbedRequest } from "./embedder-host.js";

/** What memory needs from an embedder, wherever the model runs. */
export interface TextEmbedder {
  ready(): Promise<boolean>;
  embed(texts: string[]): Promise<Float32Array[] | null>;
  embedQuery(text: string): Promise<Float32Array | null>;
  /** Lets in-flight work finish and releases the model. */
  close?(): Promise<void>;
}

/** The parts of a worker thread the client uses, so tests can stand in for one. */
export interface EmbedWorker {
  postMessage(request: EmbedRequest): void;
  on(event: "message", listener: (reply: EmbedReply) => void): unknown;
  on(event: "error" | "messageerror", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  unref(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** The unavailable answer, given when the thread goes away first. */
  fallback: false | null;
}

/**
 * An embedder whose model runs in a worker thread that serveEmbedder answers in. The thread starts on first use and
 * never keeps the process alive by itself. If it fails or exits, every waiting call gets the unavailable answer and
 * retrieval falls back to full-text search, as when the model cannot load.
 */
export class WorkerEmbedder implements TextEmbedder {
  private worker: EmbedWorker | null = null;
  private exited: Promise<void> = Promise.resolve();
  private failed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly spawn: () => EmbedWorker,
    private readonly closeTimeoutMs = 5000,
  ) {}

  ready(): Promise<boolean> {
    return this.request<boolean>({ op: "ready" }, false);
  }

  embed(texts: string[]): Promise<Float32Array[] | null> {
    return texts.length === 0 ? Promise.resolve([]) : this.request<Float32Array[] | null>({ op: "embed", texts }, null);
  }

  embedQuery(text: string): Promise<Float32Array | null> {
    return this.request<Float32Array | null>({ op: "embedQuery", text }, null);
  }

  /**
   * Asks the thread to exit once its work is done, and waits a bounded time. It is never terminated: stopping a
   * thread inside a native model call aborts the whole process, and an unreferenced thread cannot hold exit up.
   */
  async close(): Promise<void> {
    this.failed = true;
    const worker = this.worker;
    if (!worker) return;
    worker.postMessage({ op: "close" });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.closeTimeoutMs)))]);
    clearTimeout(timer);
  }

  private request<T>(call: EmbedCall, fallback: false | null): Promise<T> {
    const worker = this.failed ? null : this.start();
    if (!worker) return Promise.resolve(fallback as T);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, fallback });
      worker.postMessage({ ...call, id });
    });
  }

  private start(): EmbedWorker | null {
    if (this.worker) return this.worker;
    let worker: EmbedWorker;
    try {
      worker = this.spawn();
    } catch {
      this.failed = true;
      return null;
    }
    worker.unref();
    this.exited = new Promise((resolve) => worker.on("exit", () => resolve()));
    worker.on("message", (reply) => this.answer(reply));
    const fail = () => this.fail();
    worker.on("error", fail);
    worker.on("messageerror", fail);
    worker.on("exit", fail);
    this.worker = worker;
    return worker;
  }

  private answer(reply: EmbedReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if ("error" in reply) pending.reject(new Error(reply.error));
    else {
      if (reply.result === false) this.failed = true;
      pending.resolve(reply.result);
    }
  }

  /** The thread is gone or broken: waiting calls get the unavailable answer, and later ones never start another. */
  private fail(): void {
    this.failed = true;
    for (const pending of this.pending.values()) pending.resolve(pending.fallback);
    this.pending.clear();
  }
}
