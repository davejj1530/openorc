import { LinkCloseCode } from "@openorc/link";
import type { ClientPush } from "@openorc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager, type LinkState } from "./manager";
import { effectsFor, FakeMac, lan, lanAddress, pairedWith, tailnet } from "./test-fixtures/fake-mac";
import type { NetworkKind } from "./saved-macs";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const started = 1_000_000;

function start(mac: FakeMac, network: NetworkKind = "wifi", effects = pairedWith(mac)) {
  const manager = new ConnectionManager(effects);
  const states: LinkState[] = [];
  manager.subscribe(() => states.push(manager.getState()));
  const pushes: ClientPush[] = [];
  manager.connection.onPush((push) => pushes.push(push));
  manager.start(network);
  return { manager, effects, states, pushes };
}

const dialed = (mac: FakeMac) => mac.dials.map(({ host, at }) => `${host}@${at - started}`);

describe("route race", () => {
  it("starts the next route 250 ms after the one before, and the first handshake wins", async () => {
    const mac = new FakeMac();
    mac.routes = [lan, lanAddress, tailnet];
    mac.behave(lan, { kind: "silent" });
    mac.behave(lanAddress, { kind: "answer" });
    mac.behave(tailnet, { kind: "answer" });
    const { manager } = start(mac, "wifi", pairedWith(mac));
    await advance(400);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lanAddress, mac: { name: "Studio" } });
    expect(dialed(mac)).toEqual(["studio.local@0", "192.168.1.20@250"]);
    expect(mac.live).toHaveLength(1);
  });

  it("starts the next route at once when one fails", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "down" });
    mac.behave(tailnet, { kind: "answer" });
    const { manager } = start(mac);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: tailnet });
    expect(dialed(mac)).toEqual(["studio.local@0", "100.64.0.7@0"]);
  });

  it("tries only the tailnet on cellular", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    mac.behave(tailnet, { kind: "answer" });
    const { manager } = start(mac, "cellular");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: tailnet });
    expect(dialed(mac)).toEqual(["100.64.0.7@0"]);
  });

  it("gives each route 4 s, then waits to try again", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "silent" });
    mac.behave(tailnet, { kind: "silent" });
    const { manager } = start(mac);
    await advance(4_249);
    expect(manager.getState().kind).toBe("connecting");
    await advance(1);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable", retryAt: started + 4_250 + 500 });
  });

  it("stops at a refusal, since every route reaches the same Mac", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "refuse", reason: "busy" });
    mac.behave(tailnet, { kind: "answer", delayMs: 100 });
    const { manager } = start(mac);
    await advance(400);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "busy" });
    expect(dialed(mac)).toEqual(["studio.local@0"]);
  });

  it("forgets the Mac and its key when the Mac no longer knows this phone", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const effects = pairedWith(mac);
    mac.paired.clear();
    const { manager } = start(mac, "wifi", effects);
    await advance(10);
    expect(manager.getState()).toEqual({ kind: "unpaired" });
    expect(effects.macs.saved.size).toBe(0);
    expect(effects.keys.stored.size).toBe(0);
    expect(effects.forgotten).toEqual([mac.id]);
  });

  it("learns the routes the Mac lists in its hello", async () => {
    const mac = new FakeMac();
    mac.behave(lanAddress, { kind: "answer" });
    const effects = pairedWith(mac, [lanAddress]);
    mac.routes = [lan, tailnet];
    start(mac, "wifi", effects);
    await advance(10);
    expect(effects.macs.saved.get(mac.id)).toMatchObject({ routes: [lan, tailnet, lanAddress], lastRoute: lanAddress });
  });
});

describe("reconnecting", () => {
  it("backs off 0.5, 1, 2, 4, 8, then 15 s with jitter", async () => {
    const mac = new FakeMac();
    mac.routes = [lan];
    start(mac, "wifi", pairedWith(mac, [lan]));
    await advance(60_000);
    const gaps = mac.dials.slice(1).map((dial, index) => dial.at - mac.dials[index]!.at);
    // random() is 0.5 here, which puts the jittered step at 15 s exactly.
    expect(gaps).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  });

  it("starts the backoff over after a session", async () => {
    const mac = new FakeMac();
    mac.routes = [lan];
    const { manager } = start(mac, "wifi", pairedWith(mac, [lan]));
    await advance(3_600);
    mac.behave(lan, { kind: "answer" });
    await advance(4_000);
    expect(manager.getState().kind).toBe("connected");
    mac.behave(lan, { kind: "down" });
    const before = mac.dials.length;
    mac.live[0]!.close(LinkCloseCode.normal);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable", retryAt: Date.now() - 10 + 500 });
    await advance(500);
    expect(mac.dials.length).toBe(before + 1);
  });

  it("pings every 20 s, and treats a Mac that stops answering as gone", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager } = start(mac);
    await advance(10);
    await advance(40_000);
    expect(mac.heard.filter((message) => message.t === "ping").map((message) => message.t === "ping" && message.id)).toEqual([0, 1, 2]);
    expect(manager.getState().kind).toBe("connected");
    mac.mute = true;
    await advance(20_000 + 10_000);
    expect(mac.sessions[0]!.closed).toBe(true);
    expect(manager.getState().kind).not.toBe("connected");
  });
});

describe("the Mac's reasons for closing", () => {
  it("shows a restarting Mac as paused and comes back once it does", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager, states } = start(mac);
    await advance(10);
    mac.behave(lan, { kind: "down" });
    mac.behave(tailnet, { kind: "down" });
    mac.closeAll("update");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "restarting" });
    await advance(500);
    expect(manager.getState()).toMatchObject({ why: "restarting" });
    mac.behave(lan, { kind: "answer" });
    await advance(1_000);
    expect(manager.getState().kind).toBe("connected");
    expect(states.some((state) => state.kind === "connecting" && state.why === "restarting")).toBe(true);
  });

  it("says when phone access is off on the Mac", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager } = start(mac);
    await advance(10);
    mac.behave(lan, { kind: "down" });
    mac.closeAll("disabled");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "disabled" });
  });

  it("forgets the Mac when the Mac removes this phone", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager, effects } = start(mac);
    await advance(10);
    mac.closeAll("removed");
    await advance(10);
    expect(manager.getState()).toEqual({ kind: "unpaired" });
    expect(effects.macs.saved.size).toBe(0);
    expect(effects.keys.stored.size).toBe(0);
    await advance(60_000);
    expect(mac.dials).toHaveLength(1);
  });
});

describe("app and network changes", () => {
  it("closes cleanly after 20 s in the background and reconnects at once in the foreground", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager } = start(mac);
    await advance(10);
    const closed = new Promise<number>((resolve) => mac.sessions[0]!.onClose(resolve));
    manager.appState("background");
    await advance(19_000);
    expect(manager.getState().kind).toBe("connected");
    await advance(1_000);
    expect(await closed).toBe(LinkCloseCode.normal);
    expect(manager.getState()).toMatchObject({ kind: "suspended" });
    await advance(120_000);
    expect(mac.dials).toHaveLength(1);
    manager.appState("active");
    await advance(10);
    expect(mac.dials).toHaveLength(2);
    expect(manager.getState().kind).toBe("connected");
  });

  it("keeps the session through a short trip to the background and checks it on return", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager } = start(mac);
    await advance(10);
    manager.appState("background");
    await advance(5_000);
    manager.appState("active");
    await advance(10);
    expect(mac.sessions[0]!.closed).toBe(false);
    expect(mac.heard.filter((message) => message.t === "ping")).toHaveLength(2);
  });

  it("moves a tailnet session to the LAN when Wi-Fi returns", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    mac.behave(tailnet, { kind: "answer" });
    const { manager, pushes } = start(mac, "cellular");
    await advance(10);
    expect(manager.getState()).toMatchObject({ route: tailnet, serial: 1 });
    manager.setNetwork("wifi");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan, serial: 2 });
    expect(mac.sessions[0]!.closed).toBe(true);
    expect(mac.live).toHaveLength(1);
    expect(pushes.filter((push) => push.type === "session")).toEqual([
      { type: "session", resumed: false },
      { type: "session", resumed: true },
    ]);
  });

  it("leaves the LAN for the tailnet when Wi-Fi goes", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    mac.behave(tailnet, { kind: "answer" });
    const { manager } = start(mac, "wifi");
    await advance(10);
    manager.setNetwork("cellular");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: tailnet });
  });

  it("waits for a network, then tries at once", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager } = start(mac, "none");
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "offline", retryAt: null });
    await advance(60_000);
    expect(mac.dials).toHaveLength(0);
    manager.setNetwork("wifi");
    await advance(10);
    expect(manager.getState().kind).toBe("connected");
  });
});

describe("pairing", () => {
  it("spends the code over the first route that answers and keeps the Mac", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const effects = effectsFor(mac);
    const { manager } = start(mac, "wifi", effects);
    expect(manager.getState()).toEqual({ kind: "unpaired" });
    const pairing = manager.pair(mac.pairingUrl());
    await advance(10);
    expect(await pairing).toEqual({ ok: true, mac: { id: mac.id, name: "Studio" } });
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan, mac: { id: mac.id } });
    expect(effects.macs.activeId()).toBe(mac.id);
    expect(effects.keys.stored.has(mac.id)).toBe(true);
    expect(mac.paired.size).toBe(1);
  });

  it("explains a spent code, an expired one and a foreign one, keeping nothing", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const effects = effectsFor(mac);
    const { manager } = start(mac, "wifi", effects);
    const spent = mac.pairingUrl();
    mac.offer = null;
    const pairing = manager.pair(spent);
    await advance(10);
    expect(await pairing).toEqual({ ok: false, message: "This code was already used or has expired. Show a new one on your Mac." });
    expect(await manager.pair(mac.pairingUrl(Date.now() - 1))).toEqual({ ok: false, message: "This code has expired. Show a new one on your Mac." });
    expect(await manager.pair("https://example.com")).toEqual({ ok: false, message: "This is not an OpenOrc pairing code." });
    expect(effects.macs.saved.size).toBe(0);
    expect(effects.keys.stored.size).toBe(0);
    expect(manager.getState()).toEqual({ kind: "unpaired" });
  });
});
