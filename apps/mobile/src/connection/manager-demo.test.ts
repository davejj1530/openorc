import type { MacMessage, PhoneMessage } from "@openorc/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneLine } from "./link-connection";
import { ConnectionManager, type DemoMac, type LinkState } from "./manager";
import { effectsFor, FakeMac, lan, pairedWith } from "./test-fixtures/fake-mac";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A demo that answers every call with the method's name, and records what the phone sends it. */
function testDemo() {
  const heard: PhoneMessage[] = [];
  const lines: Array<PhoneLine & { end(): void }> = [];
  const demo: DemoMac = {
    mac: { id: "demo", name: "Demo Mac" },
    open() {
      const listeners = new Set<(message: MacMessage) => void>();
      const closers = new Set<(code: number, reason: string) => void>();
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        closers.forEach((listener) => listener(1000, ""));
      };
      const line = {
        get closed() {
          return closed;
        },
        send(message: PhoneMessage) {
          heard.push(message);
          if (message.t === "rpc") queueMicrotask(() => listeners.forEach((listener) => listener({ t: "rpc.result", id: message.id, result: message.method })));
        },
        onMessage: (listener: (message: MacMessage) => void) => (listeners.add(listener), () => listeners.delete(listener)),
        onBytes: () => () => undefined,
        onClose: (listener: (code: number, reason: string) => void) => (closers.add(listener), () => closers.delete(listener)),
        close: finish,
        end: finish,
      };
      lines.push(line);
      return line;
    },
  };
  return { demo, heard, lines };
}

function start(mac: FakeMac, effects = effectsFor(mac)) {
  const manager = new ConnectionManager(effects);
  const states: LinkState[] = [];
  manager.subscribe(() => {
    const state = manager.getState();
    if (state !== states.at(-1)) states.push(state);
  });
  manager.start("wifi");
  return { manager, effects, states };
}

describe("the demo Mac", () => {
  it("shows while no Mac is paired, as a Mac reached inside the app, without dialing, saving or asking the internet", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager, effects } = start(mac);
    const { demo } = testDemo();
    manager.showDemo(demo);
    expect(manager.getState()).toEqual({ kind: "connected", mac: { id: "demo", name: "Demo Mac" }, route: { kind: "demo" }, serial: 1 });
    await advance(60_000);
    expect(mac.dials).toEqual([]);
    expect(mac.internetChecks).toBe(0);
    expect(effects.macs.saved.size).toBe(0);
    expect(effects.macs.activeId()).toBeNull();
    expect(effects.keys.stored.size).toBe(0);
    expect(manager.getMacs()).toEqual([]);
  });

  it("carries the client's calls and interest over its line, with no pings", async () => {
    const { manager } = start(new FakeMac());
    const { demo, heard } = testDemo();
    manager.showDemo(demo);
    manager.connection.setFrameInterest(new Set(["run-1"]));
    await expect(manager.connection.call("projects.list", {})).resolves.toBe("projects.list");
    await advance(120_000);
    expect(heard.map((message) => message.t)).toEqual(["interest", "interest", "rpc"]);
  });

  it("stays through the background, network changes and retries", async () => {
    const mac = new FakeMac();
    const { manager, states } = start(mac);
    const { demo, lines } = testDemo();
    manager.showDemo(demo);
    manager.appState("background");
    await advance(90_000);
    manager.appState("active");
    manager.setNetwork("cellular");
    manager.setNetwork("none");
    await manager.retry();
    expect(manager.getState()).toMatchObject({ kind: "connected", route: { kind: "demo" } });
    expect(states.map((state) => state.kind)).toEqual(["unpaired", "connected"]);
    expect(lines[0]!.closed).toBe(false);
    expect(mac.dials).toEqual([]);
  });

  it("ends back at no Mac, its line closed and its calls refused", async () => {
    const { manager } = start(new FakeMac());
    const { demo, lines } = testDemo();
    manager.showDemo(demo);
    manager.endDemo();
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: null });
    expect(lines[0]!.closed).toBe(true);
    await expect(manager.connection.call("projects.list", {})).rejects.toThrow("This phone is not connected to a Mac.");
  });

  it("ends when its line closes, and Forget on it ends it too", async () => {
    const { manager } = start(new FakeMac());
    const { demo, lines } = testDemo();
    manager.showDemo(demo);
    lines[0]!.end();
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: null });
    manager.showDemo(demo);
    expect(manager.getState()).toMatchObject({ kind: "connected", serial: 2 });
    await manager.forget("demo");
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: null });
    expect(lines.map((line) => line.closed)).toEqual([true, true]);
  });

  it("gives way to a Mac paired meanwhile, which is the only one saved", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager, effects, states } = start(mac);
    const { demo, lines } = testDemo();
    manager.showDemo(demo);
    const pairing = manager.pair(mac.pairingUrl());
    await advance(10);
    expect(await pairing).toMatchObject({ ok: true });
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan, mac: { id: mac.id } });
    expect(lines[0]!.closed).toBe(true);
    expect([...effects.macs.saved.keys()]).toEqual([mac.id]);
    expect(states.some((state) => state.kind === "connected" && state.route.kind === "demo")).toBe(true);
    expect(states.at(-1)).toMatchObject({ kind: "connected", mac: { id: mac.id } });
  });

  it("is not offered over a saved Mac", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager } = start(mac, pairedWith(mac));
    await advance(10);
    const { demo, lines } = testDemo();
    manager.showDemo(demo);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan });
    expect(lines).toEqual([]);
  });
});
