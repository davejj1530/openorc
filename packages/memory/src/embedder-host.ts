import { Embedder } from "./embedder.js";

/** One call on an embedder running in a worker thread. */
export type EmbedCall = { op: "ready" } | { op: "embed"; texts: string[] } | { op: "embedQuery"; text: string };

export type EmbedRequest = (EmbedCall & { id: number }) | { op: "close" };

export type EmbedReply = { id: number; result: boolean | Float32Array | Float32Array[] | null } | { id: number; error: string };

/** The end of a worker's message channel the host listens and answers on. */
export interface EmbedPort {
  on(event: "message", listener: (request: EmbedRequest) => void): unknown;
  postMessage(reply: EmbedReply, transfer?: ArrayBuffer[]): void;
}

type Model = Pick<Embedder, "ready" | "embed" | "embedQuery">;

/**
 * Runs the embedding model for a worker thread. Only this module and the embedder load in the worker; the model's
 * load and each batch block this thread instead of the core's. A close request ends a long embed at its next batch
 * and the thread once nothing is in flight: ending it during a native model call would abort the whole process.
 */
export function serveEmbedder(port: EmbedPort, cacheDir: string, exit: () => void = () => process.exit(0), model: Model = new Embedder(cacheDir)): void {
  let inFlight = 0;
  let closing = false;
  const settle = () => {
    inFlight -= 1;
    if (closing && inFlight === 0) exit();
  };
  port.on("message", (request) => {
    if (request.op === "close") {
      closing = true;
      if (inFlight === 0) exit();
      return;
    }
    const { id } = request;
    if (closing) {
      port.postMessage({ id, result: null });
      return;
    }
    inFlight += 1;
    const work = callModel(model, request, () => closing);
    work
      .then(
        (result) => port.postMessage({ id, result }, buffers(result)),
        (error: unknown) => port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(settle);
  });
}

/** Vectors move to the core without a copy. */
function buffers(result: boolean | Float32Array | Float32Array[] | null): ArrayBuffer[] {
  if (result instanceof Float32Array) return [result.buffer as ArrayBuffer];
  return Array.isArray(result) ? result.map((vector) => vector.buffer as ArrayBuffer) : [];
}

function callModel(model: Model, call: EmbedCall, isClosing: () => boolean) {
  if (call.op === "ready") return model.ready();
  if (call.op === "embed") return model.embed(call.texts, isClosing);
  return model.embedQuery(call.text);
}
