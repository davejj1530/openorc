import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { serveEmbedder, type EmbedRequest } from "./embedder-host.js";
import { WorkerEmbedder, type EmbedWorker } from "./worker-embedder.js";

/** A worker thread stand-in: the client talks to serveEmbedder over a real message channel. */
class FakeWorker extends EventEmitter implements EmbedWorker {
  readonly channel = new MessageChannel();
  readonly sent: EmbedRequest[] = [];
  unref = vi.fn();
  exited = false;

  constructor(model: Parameters<typeof serveEmbedder>[3]) {
    super();
    this.channel.port1.on("message", (reply) => this.emit("message", reply));
    const host = {
      on: (_event: "message", listener: (request: EmbedRequest) => void) => this.channel.port2.on("message", listener),
      postMessage: this.channel.port2.postMessage.bind(this.channel.port2),
    };
    serveEmbedder(host, "/unused", () => this.exit(0), model);
  }

  postMessage(request: EmbedRequest): void {
    this.sent.push(request);
    this.channel.port1.postMessage(request);
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.channel.port1.close();
    this.emit("exit", code);
  }
}

const vector = (x: number) => Float32Array.from([x, x + 1]);
const workers: FakeWorker[] = [];
afterEach(() => workers.splice(0).forEach((worker) => worker.exit(0)));

function setup(model: Partial<Parameters<typeof serveEmbedder>[3]> = {}) {
  const full = { ready: async () => true, embed: async (texts: string[]) => texts.map((_, i) => vector(i)), embedQuery: async () => vector(9), ...model };
  const spawn = vi.fn(() => {
    const worker = new FakeWorker(full);
    workers.push(worker);
    return worker;
  });
  return { embedder: new WorkerEmbedder(spawn, 200), spawn, worker: () => workers.at(-1)! };
}

it("starts its thread on first use and answers with the model's vectors", async () => {
  const { embedder, spawn, worker } = setup();
  expect(spawn).not.toHaveBeenCalled();
  expect(await embedder.embed([])).toEqual([]);
  expect(spawn).not.toHaveBeenCalled();
  expect(await embedder.ready()).toBe(true);
  expect(await embedder.embed(["a", "b"])).toEqual([vector(0), vector(1)]);
  expect(await embedder.embedQuery("q")).toEqual(vector(9));
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(worker().unref).toHaveBeenCalled();
});

it("passes model errors through and remembers an unavailable model without asking again", async () => {
  const { embedder, worker } = setup({ ready: async () => false, embedQuery: async () => Promise.reject(new Error("model broke")) });
  await expect(embedder.embedQuery("q")).rejects.toThrow("model broke");
  expect(await embedder.ready()).toBe(false);
  const asked = worker().sent.length;
  expect(await embedder.embed(["a"])).toBeNull();
  expect(worker().sent).toHaveLength(asked);
});

it("gives waiting calls the unavailable answer when the thread dies, and never starts another", async () => {
  const { embedder, spawn, worker } = setup({ embed: () => new Promise(() => undefined), embedQuery: () => new Promise(() => undefined) });
  const embedding = embedder.embed(["a"]);
  const query = embedder.embedQuery("q");
  await vi.waitFor(() => expect(worker().sent).toHaveLength(2));
  worker().emit("error", new Error("native crash"));
  expect(await embedding).toBeNull();
  expect(await query).toBeNull();
  expect(await embedder.ready()).toBe(false);
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("closes by letting the thread end its embed at the next batch and exit by itself", async () => {
  let release = () => undefined as void;
  let stopped: (() => boolean) | undefined;
  const { embedder, worker } = setup({
    embed: (_texts, stop) =>
      new Promise((resolve) => {
        stopped = stop;
        release = () => resolve(stop?.() ? null : [vector(0)]);
      }),
  });
  const embedding = embedder.embed(["a"]);
  await vi.waitFor(() => expect(stopped).toBeDefined());
  const closing = embedder.close();
  await vi.waitFor(() => expect(stopped?.()).toBe(true));
  expect(worker().exited).toBe(false);
  release();
  await closing;
  expect(await embedding).toBeNull();
  expect(worker().exited).toBe(true);
  expect(await embedder.embedQuery("later")).toBeNull();
});

it("closes without starting a thread it never needed", async () => {
  const { embedder, spawn } = setup();
  await embedder.close();
  expect(spawn).not.toHaveBeenCalled();
});
