import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Broadcast, RpcReply } from "@openorc/core";
import type { RpcRequest } from "@openorc/protocol";
import { windowPorts, type WindowPort } from "./reply";

/** Stands in for the core's MessagePortMain to one window: it emits `{ data }` events and records what the core posts. */
class FakeWindow extends EventEmitter implements WindowPort {
  readonly received: (Broadcast | RpcReply)[] = [];
  postMessage(message: Broadcast | RpcReply): void {
    this.received.push(message);
  }
  request(id: number, params: unknown): void {
    this.emit("message", { data: { type: "rpc", id, method: "fixture.echo", params } });
  }
}

const echo = async (request: RpcRequest): Promise<RpcReply> => ({ type: "rpc.result", id: request.id, result: request.params });
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("window ports", () => {
  it("answers each window on its own port when both windows use the same request id", async () => {
    const windows = windowPorts(echo);
    const first = new FakeWindow();
    const second = new FakeWindow();
    windows.attach(first);
    windows.attach(second);
    first.request(1, "first window's result");
    second.request(1, "second window's result");
    await settled();
    expect(first.received).toEqual([{ type: "rpc.result", id: 1, result: "first window's result" }]);
    expect(second.received).toEqual([{ type: "rpc.result", id: 1, result: "second window's result" }]);
  });

  it("sends nothing to a window that closed, not even the answer to its own request", async () => {
    let finish!: () => void;
    const windows = windowPorts((request) => new Promise((resolve) => (finish = () => resolve({ type: "rpc.result", id: request.id, result: "late" }))));
    const closing = new FakeWindow();
    const staying = new FakeWindow();
    windows.attach(closing);
    windows.attach(staying);
    closing.request(7, null);
    closing.emit("close");
    finish();
    await settled();
    windows.broadcast({ type: "invalidate", keys: ["threads"] });
    expect(closing.received).toEqual([]);
    expect(staying.received).toEqual([{ type: "invalidate", keys: ["threads"] }]);
  });

  it("delivers what the core broadcast while answering before the answer", async () => {
    const frame: Broadcast = { type: "frame", frame: { runId: "run", seq: 1, events: [] } };
    const windows = windowPorts(async (request) => {
      windows.broadcast(frame);
      return echo(request);
    });
    const window = new FakeWindow();
    windows.attach(window);
    window.request(3, "page");
    await settled();
    expect(window.received).toEqual([frame, { type: "rpc.result", id: 3, result: "page" }]);
  });
});
