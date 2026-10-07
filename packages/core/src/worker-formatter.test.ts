import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { serveFormatter, type FormatReply, type FormatRequest } from "./formatter-host.js";
import { WorkerFormatter, type FormatWorker } from "./worker-formatter.js";

/** A worker thread stand-in: the client talks to serveFormatter over a real message channel. */
class FakeWorker extends EventEmitter implements FormatWorker {
  readonly channel = new MessageChannel();
  unref = vi.fn();
  terminated = false;

  constructor(format?: Parameters<typeof serveFormatter>[1]) {
    super();
    this.channel.port1.on("message", (reply: FormatReply) => this.emit("message", reply));
    serveFormatter({ on: (_event, listener) => this.channel.port2.on("message", listener), postMessage: (reply) => this.channel.port2.postMessage(reply) }, format);
  }

  postMessage(request: FormatRequest): void {
    this.channel.port1.postMessage(request);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    this.channel.port1.close();
    return 1;
  }
}

const workers: FakeWorker[] = [];
afterEach(() => workers.splice(0).forEach((worker) => void worker.terminate()));

function spawning(format?: Parameters<typeof serveFormatter>[1]) {
  return vi.fn(() => {
    const worker = new FakeWorker(format);
    workers.push(worker);
    return worker;
  });
}

it("formats with the bundled Prettier, keeping a CRLF file's line endings, and passes Prettier's errors through", async () => {
  const formatter = new WorkerFormatter(spawning());
  expect(await formatter.format("const a = {b:1}\r\nlet c=2\r\n", "src/app.ts")).toBe("const a = { b: 1 };\r\nlet c = 2;\r\n");
  expect(await formatter.format("title:   Notes\n", "docs/notes.yml")).toBe("title: Notes\n");
  await expect(formatter.format("const = ;\n", "src/broken.ts")).rejects.toThrow("(1:7)");
});

it("ends a thread whose format runs past the timeout, failing it, and formats the next request in a new thread", async () => {
  const spawn = spawning(() => new Promise<never>(() => undefined));
  const formatter = new WorkerFormatter(spawn, 100);
  await expect(formatter.format("a", "a.ts")).rejects.toThrow("took longer than 0.1 seconds");
  expect(workers[0]?.terminated).toBe(true);
  spawn.mockImplementationOnce(() => {
    const worker = new FakeWorker(async (text) => text.toUpperCase());
    workers.push(worker);
    return worker;
  });
  expect(await formatter.format("b", "b.ts")).toBe("B");
  expect(spawn).toHaveBeenCalledTimes(2);
});
