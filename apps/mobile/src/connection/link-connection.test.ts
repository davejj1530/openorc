import type { ClientPush } from "@openorc/client";
import { LinkCloseCode, type PhoneMessage } from "@openorc/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DROPPED } from "./link-connection";
import { ConnectionManager } from "./manager";
import { effectsFor, FakeMac, lan, pairedWith } from "./test-fixtures/fake-mac";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function connect(mac: FakeMac, effects = pairedWith(mac)) {
  const manager = new ConnectionManager(effects);
  const pushes: ClientPush[] = [];
  manager.connection.onPush((push) => pushes.push(push));
  manager.start("wifi");
  return { manager, connection: manager.connection, pushes };
}

/** What the Mac heard, without pings, as short lines. */
const wire = (mac: FakeMac) =>
  mac.heard.flatMap((message: PhoneMessage) => {
    if (message.t === "rpc") return [`rpc ${message.method}`];
    if (message.t === "interest") return [`interest ${message.runIds.join(",")}`];
    return [];
  });

describe("calls over the link", () => {
  it("holds calls made while connecting and sends them after the interest", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer", delayMs: 1_000 });
    mac.answer = (method) => (method === "projects.list" ? [] : undefined);
    const { connection } = connect(mac);
    connection.setFrameInterest(new Set(["run-1"]));
    const projects = connection.call("projects.list", {});
    await advance(1_010);
    expect(await projects).toEqual([]);
    expect(wire(mac)).toEqual(["interest run-1", "rpc projects.list"]);
  });

  it("gives up on a call after 8 s without a session", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "silent" });
    const { connection } = connect(mac);
    const projects = connection.call("projects.list", {});
    const failed = expect(projects).rejects.toThrow("Your Mac did not answer in time.");
    await advance(8_000);
    await failed;
  });

  it("refuses calls at once while no Mac is paired", async () => {
    const mac = new FakeMac();
    const { connection } = connect(mac, effectsFor(mac));
    await expect(connection.call("projects.list", {})).rejects.toThrow("This phone is not connected to a Mac.");
  });

  it("fails a call in flight when its session drops, and never sends it again", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { connection, manager } = connect(mac);
    await advance(10);
    const sending = connection.call("runs.send", { runId: "run-1", text: "ship it" });
    const failed = expect(sending).rejects.toThrow(DROPPED);
    await advance(10);
    mac.live[0]!.close(LinkCloseCode.normal);
    await advance(10);
    await failed;
    await advance(1_000);
    expect(manager.getState().kind).toBe("connected");
    expect(wire(mac).filter((line) => line === "rpc runs.send")).toHaveLength(1);
  });

  it("tells every new session the interest, then reports it resumed", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { connection, pushes } = connect(mac);
    await advance(10);
    connection.setFrameInterest(new Set(["run-1", "run-2"]));
    await advance(10);
    mac.live[0]!.close(LinkCloseCode.normal);
    await advance(1_000);
    expect(wire(mac)).toEqual(["interest ", "interest run-1,run-2", "interest run-1,run-2"]);
    expect(pushes.filter((push) => push.type === "session")).toEqual([
      { type: "session", resumed: false },
      { type: "session", resumed: true },
    ]);
  });

  it("passes pushes and gaps through in client terms", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { pushes } = connect(mac);
    await advance(10);
    mac.send({ t: "push", push: { type: "invalidate", keys: ["threads"] } });
    mac.send({ t: "push", push: { type: "notify", kind: "finished", threadId: "t-1", taskId: null, title: "Done", body: "Shipped" } });
    mac.send({ t: "push", push: { type: "ready" } });
    mac.send({ t: "gap", runIds: ["run-1"] });
    await advance(10);
    expect(pushes.slice(1)).toEqual([
      { type: "invalidate", keys: ["threads"] },
      { type: "notify", notice: { kind: "finished", threadId: "t-1", taskId: null, title: "Done", body: "Shipped" } },
      { type: "gap", runIds: ["run-1"] },
    ]);
  });

  it("asks about this phone over the same rpc as calls, and hears the Mac's answer", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const states = { sandbox: "ready", production: "no-key" };
    mac.answer = (method) => (method === "push.register" ? states : undefined);
    const { connection } = connect(mac);
    const registration = { token: "ab".repeat(32), environment: "sandbox", alerts: "all", sound: true } as const;
    const registered = connection.device("push.register", { registration });
    await advance(10);
    expect(await registered).toEqual(states);
    expect(mac.heard).toContainEqual(expect.objectContaining({ t: "rpc", method: "push.register", params: { registration } }));
  });

  it("asks about this session over the same rpc as calls, and hears the Mac's answer", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const closed = { open: false } as const;
    const answers: Record<string, unknown> = { "preview.watch": closed, "preview.unwatch": null };
    mac.answer = (method) => answers[method];
    const { connection } = connect(mac);
    const watched = connection.session("preview.watch", { threadId: "t-1", width: 786, pace: "lan" });
    await advance(10);
    expect(await watched).toEqual(closed);
    expect(await connection.session("preview.unwatch", {})).toBeNull();
    expect(mac.heard).toContainEqual(expect.objectContaining({ t: "rpc", method: "preview.watch", params: { threadId: "t-1", width: 786, pace: "lan" } }));
  });

  it("hands a watched Preview's pushes to its own listeners, never to the client's caches", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { connection, pushes } = connect(mac);
    const heard: unknown[] = [];
    const stop = connection.onPreview((push) => heard.push(push));
    await advance(10);
    const state = { open: true, pane: "p1", address: "http://127.0.0.1:47831/", title: "QA Page", phase: "live", error: null, frame: { seq: 3, width: 786, height: 566 } } as const;
    mac.send({ t: "push", push: { type: "preview", threadId: "t-1", state } });
    mac.send({ t: "push", push: { type: "preview.ended", threadId: "t-1", message: "This thread is gone." } });
    await advance(10);
    stop();
    mac.send({ t: "push", push: { type: "preview", threadId: "t-1", state: { open: false } } });
    await advance(10);
    expect(heard).toEqual([
      { type: "preview", threadId: "t-1", state },
      { type: "preview.ended", threadId: "t-1", message: "This thread is gone." },
    ]);
    expect(pushes.filter((push) => push.type !== "session")).toEqual([]);
  });

  it("keeps a copy of each chunk, made in one step and not byte by byte", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { connection } = connect(mac);
    await advance(10);
    const asset = connection.asset({ kind: "preview", threadId: "t-1", seq: 1 });
    await advance(10);
    const request = mac.heard.find((message) => message.t === "asset");
    if (request?.t !== "asset") throw new Error("no asset request");
    mac.send({ t: "asset.bytes", id: request.id, mime: "image/jpeg", size: 4 });
    await advance(10);
    const chunk = new Uint8Array([1, 2, 3, 4]);
    // Walking it allocates an iterator result per byte: 768 KB of garbage for an 8 KB frame in Hermes.
    Object.defineProperty(chunk, Symbol.iterator, {
      value: () => {
        throw new Error("walked byte by byte");
      },
    });
    connection.receiveBytes(request.id, chunk, true);
    chunk.set([9, 9, 9, 9]);
    expect(await asset).toEqual({ mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3, 4]) });
  });

  it("hands over an image's bytes", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { connection } = connect(mac);
    await advance(10);
    const asset = connection.asset({ kind: "attachment", name: "shot.png" });
    await advance(10);
    const request = mac.heard.find((message) => message.t === "asset");
    if (request?.t !== "asset") throw new Error("no asset request");
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
    mac.send({ t: "asset.bytes", id: request.id, mime: "image/png", size: bytes.length });
    void mac.live[0]!.sendBytes(request.id, bytes);
    await advance(50);
    expect(await asset).toEqual({ mime: "image/png", bytes });
  });
});
