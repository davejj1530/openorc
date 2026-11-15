/** A request body of raw bytes, read as it is sent and never held whole: a file too large or too many to buffer. */
export class RawBody {
  constructor(readonly chunks: () => AsyncIterable<Uint8Array>) {}
}

/** One raw body on its way: what fetch sends, the signal that ends it, and what its source threw, if it did. */
export interface RawSend {
  stream: ReadableStream<Uint8Array>;
  /** Aborts when no piece went, and no answer came, for `idleMs`: a large body may take as long as it keeps moving. */
  signal: AbortSignal;
  /** The source's own error, which is the reason to give instead of the network's. */
  failure(): unknown;
  /** The answer's headers arrived, or the request failed: the idle clock stops. */
  done(): void;
}

export function rawSend(body: RawBody, idleMs: number): RawSend {
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), idleMs);
  const beat = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleMs);
  };
  let failed: unknown;
  let source: AsyncIterator<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        source ??= body.chunks()[Symbol.asyncIterator]();
        const next = await source.next();
        beat();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        failed = error;
        controller.error(error);
      }
    },
    async cancel() {
      await source?.return?.();
    },
  });
  return { stream, signal: idle.signal, failure: () => failed, done: () => clearTimeout(timer) };
}

/** A request's body as fetch takes it, with the clock that ends it. */
export interface Outgoing {
  contentType: string | null;
  init: Pick<RequestInit, "body" | "signal"> & { duplex?: "half" };
  /** What the body's own source threw, if it did. */
  failure(): unknown;
  /** The answer's headers arrived, or the request failed. */
  done(): void;
}

/**
 * `body` on its way: raw bytes go as they are read, for as long as they keep moving; anything else is JSON, within
 * `timeoutMs` in all, or with the caller's `signal` within `timeoutMs` until the answer's headers.
 */
export function outgoing(body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Outgoing {
  if (body instanceof RawBody) {
    const raw = rawSend(body, timeoutMs);
    return { contentType: "application/octet-stream", init: { body: raw.stream, duplex: "half", signal: raw.signal }, failure: raw.failure, done: raw.done };
  }
  const headers = signal ? new AbortController() : null;
  const timer = headers ? setTimeout(() => headers.abort(), timeoutMs) : null;
  return {
    contentType: body === undefined ? null : "application/json",
    init: { body: body === undefined ? undefined : JSON.stringify(body), signal: signal && headers ? AbortSignal.any([signal, headers.signal]) : AbortSignal.timeout(timeoutMs) },
    failure: () => undefined,
    done: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
