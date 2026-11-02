import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { FolderPath, type EditorResult } from "@openorc/protocol";
import type { IntelligenceMessage } from "./intelligence-host.js";
import type { IntelligenceRequest } from "./typescript-intelligence.js";
import { WorkerIntelligence, type IntelligenceWorker } from "./worker-intelligence.js";

class TestWorker extends EventEmitter implements IntelligenceWorker {
  private readonly channel = new MessageChannel();
  terminated = false;
  unref = vi.fn(() => {
    this.channel.port1.unref();
    this.channel.port2.unref();
  });
  constructor(answer: boolean) {
    super();
    this.channel.port1.on("message", (reply) => this.emit("message", reply));
    if (answer)
      this.channel.port2.on("message", ({ id }: IntelligenceMessage) => this.channel.port2.postMessage({ id, result: { kind: "analysis", diagnostics: [], symbols: [] } satisfies EditorResult }));
  }
  postMessage(message: IntelligenceMessage): void {
    this.channel.port1.postMessage(message);
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    this.channel.port1.close();
    this.channel.port2.close();
    return 0;
  }
}

const workers: TestWorker[] = [];
const clients: WorkerIntelligence[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});
const input: IntelligenceRequest = { root: "/fixture", path: FolderPath.parse("main.ts"), documents: [{ path: FolderPath.parse("main.ts"), text: "const value = 1;" }], query: { kind: "analysis" } };
function client(answers: boolean[], timeout = 1_000, idleMs = 10_000) {
  const spawn = vi.fn(() => {
    const worker = new TestWorker(answers.shift() ?? true);
    workers.push(worker);
    return worker;
  });
  const engine = new WorkerIntelligence(spawn, timeout, idleMs);
  clients.push(engine);
  return { engine, spawn };
}

it("starts lazily, reuses the worker, and closes it with the host", async () => {
  const { engine, spawn } = client([true]);
  expect(spawn).not.toHaveBeenCalled();
  expect(await engine.query(input)).toMatchObject({ kind: "analysis" });
  expect(await engine.query(input)).toMatchObject({ kind: "analysis" });
  expect(spawn).toHaveBeenCalledOnce();
  expect(workers[0]?.unref).toHaveBeenCalledOnce();
  await engine.close();
  expect(workers[0]?.terminated).toBe(true);
  await expect(engine.query(input)).rejects.toThrow("shut down");
});

it("ends a wedged worker and starts a fresh one on the next request", async () => {
  const { engine, spawn } = client([false, true], 40);
  await expect(engine.query(input)).rejects.toThrow("took too long");
  expect(workers[0]?.terminated).toBe(true);
  expect(await engine.query(input)).toMatchObject({ kind: "analysis" });
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("releases idle project memory and restarts when editing resumes", async () => {
  const { engine, spawn } = client([true, true], 1_000, 20);
  await engine.query(input);
  await vi.waitFor(() => expect(workers[0]?.terminated).toBe(true));
  await engine.query(input);
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("fails every pending request after a worker crash", async () => {
  const { engine } = client([false]);
  const pending = Promise.allSettled([engine.query(input), engine.query(input)]);
  workers[0]?.emit("error", new Error("worker crashed"));
  expect(await pending).toEqual([
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: "worker crashed" }) }),
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: "worker crashed" }) }),
  ]);
});
