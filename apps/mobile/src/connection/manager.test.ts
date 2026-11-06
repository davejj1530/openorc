import { LinkCloseCode, toBase64Url } from "@openorc/link";
import { nobleCrypto } from "@openorc/link/test-fixtures/noble-crypto";
import type { ClientPush } from "@openorc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doorsOnIntent, forgetRemovedBrains } from "./hosts";
import { ConnectionManager, type LinkState } from "./manager";
import { effectsFor, FakeMac, lan, lanAddress, pairedWith, publicRoute, tailnet } from "./test-fixtures/fake-mac";
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
  manager.subscribe(() => {
    const state = manager.getState();
    if (state !== states.at(-1)) states.push(state);
  });
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

  it("says Tailscale is the way in when no tailnet address answers on cellular", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    mac.behave(tailnet, { kind: "down" });
    const { manager } = start(mac, "cellular");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "tailnet" });
    manager.setNetwork("wifi");
    // Tailscale was cellular's reason: on Wi-Fi the attempt starts with none.
    expect(manager.getState()).toMatchObject({ kind: "connecting", why: null });
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan });
  });

  it("has no route on cellular to a Mac without a tailnet address, and tries again on Wi-Fi", async () => {
    const mac = new FakeMac();
    mac.routes = [lan];
    mac.behave(lan, { kind: "answer" });
    const { manager } = start(mac, "cellular", pairedWith(mac));
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "no-route", retryAt: null });
    manager.setNetwork("wifi");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan });
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
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: { why: "removed", macName: "Studio" } });
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

describe("with no internet", () => {
  it("blames Tailscale on cellular only while the internet answers, and says No internet while nothing does", async () => {
    const mac = new FakeMac();
    mac.behave(tailnet, { kind: "silent" });
    mac.internet = "down";
    const { manager } = start(mac, "cellular");
    await advance(4_000);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "offline" });
    expect(manager.getState()).not.toMatchObject({ retryAt: null });
    // Mobile data comes back with no change iOS reports: the next attempt finds the internet, and the tailnet still silent.
    mac.internet = "up";
    await advance(500);
    expect(manager.getState()).toMatchObject({ kind: "connecting", why: "offline" });
    await advance(4_000);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "tailnet" });
    mac.internet = "down";
    await advance(1_000 + 4_000);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "offline" });
    mac.behave(tailnet, { kind: "answer" });
    mac.internet = "up";
    await advance(2_000 + 10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: tailnet });
  });

  it("takes a check that does not answer in 3 s as no internet", async () => {
    const mac = new FakeMac();
    mac.behave(tailnet, { kind: "down" });
    mac.internet = "hung";
    const { manager } = start(mac, "cellular");
    await advance(3_000 - 1);
    expect(manager.getState()).toMatchObject({ kind: "connecting", why: null });
    await advance(1);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "offline" });
  });

  it("says No internet over every route when the network is not Wi-Fi, and asks only after a race no route answered", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "down" });
    mac.behave(tailnet, { kind: "down" });
    mac.internet = "down";
    const { manager } = start(mac, "other");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "offline" });
    mac.behave(tailnet, { kind: "answer" });
    await advance(500);
    expect(manager.getState().kind).toBe("connected");
    expect(mac.internetChecks).toBe(1);
  });

  it("never asks on Wi-Fi, where the LAN answers without the internet", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "down" });
    mac.behave(tailnet, { kind: "down" });
    mac.internet = "down";
    const { manager } = start(mac, "wifi");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
    expect(mac.internetChecks).toBe(0);
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

describe("a Mac that stays silent", () => {
  it("is not reachable once it has not answered for a minute, from the minute on, until a session starts over", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "silent" });
    mac.behave(tailnet, { kind: "silent" });
    const { manager, states } = start(mac);
    // The first race gives up at 4.25 s: the phone has not heard the Mac since.
    await advance(4_250);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
    await advance(60_000 - 1);
    expect(manager.getState()).toMatchObject({ why: "unreachable" });
    await advance(1);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "silent" });
    states.length = 0;
    await advance(30_000);
    expect(states.length).toBeGreaterThan(1);
    expect(states.every((state) => "why" in state && state.why === "silent")).toBe(true);
    mac.behave(lan, { kind: "answer" });
    await advance(20_000);
    expect(manager.getState().kind).toBe("connected");
    mac.behave(lan, { kind: "silent" });
    mac.live[0]!.close(LinkCloseCode.normal);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
    // The next race fails too, and the session was this minute's start.
    await advance(500 + 4_250);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
  });

  it("reads not reachable the moment the minute ends, even mid-attempt", async () => {
    const mac = new FakeMac();
    mac.routes = [lan];
    mac.behave(lan, { kind: "silent" });
    const { manager } = start(mac, "wifi", pairedWith(mac, [lan]));
    // The minute starts as the first race gives up, at 4 s; Try again at 63 s runs until 67 s.
    await advance(63_000);
    void manager.retry();
    await advance(1_000 - 1);
    expect(manager.getState()).toMatchObject({ kind: "connecting", why: "unreachable" });
    await advance(1);
    expect(manager.getState()).toMatchObject({ kind: "connecting", why: "silent" });
  });

  it("counts only time spent asking: not while offline, on another network, or suspended", async () => {
    const away: Array<(manager: ConnectionManager, mac: FakeMac) => Promise<void>> = [
      async (manager) => {
        manager.setNetwork("none");
        await advance(5 * 60_000);
        manager.setNetwork("wifi");
      },
      async (manager) => {
        manager.setNetwork("cellular");
        await advance(5 * 60_000);
        expect(manager.getState()).toMatchObject({ why: "tailnet" });
        manager.setNetwork("wifi");
      },
      async (manager, mac) => {
        mac.internet = "down";
        manager.setNetwork("cellular");
        await advance(5 * 60_000);
        expect(manager.getState()).toMatchObject({ why: "offline" });
        manager.setNetwork("wifi");
      },
      async (manager) => {
        manager.appState("background");
        await advance(10 * 60_000);
        expect(manager.getState().kind).toBe("suspended");
        manager.appState("active");
      },
    ];
    for (const [index, gap] of away.entries()) {
      const mac = new FakeMac();
      mac.behave(lan, { kind: "answer" });
      const { manager } = start(mac);
      await advance(10);
      mac.behave(lan, { kind: "silent" });
      mac.behave(tailnet, { kind: "silent" });
      mac.live[0]!.close(LinkCloseCode.normal);
      await advance(10);
      await gap(manager, mac);
      await advance(4_300);
      expect(manager.getState(), `gap ${index}`).toMatchObject({ kind: "waiting", why: "unreachable" });
    }
  });

  it("starts the minute over once the internet answers again on the same network", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "silent" });
    mac.behave(tailnet, { kind: "silent" });
    mac.internet = "down";
    const { manager, states } = start(mac, "other");
    await advance(5 * 60_000);
    expect(manager.getState()).toMatchObject({ why: "offline" });
    mac.internet = "up";
    states.length = 0;
    await advance(30_000);
    expect(states.filter((state) => state.kind === "waiting").map((state) => "why" in state && state.why)).toEqual(["unreachable", "unreachable"]);
  });

  it("gives another Mac its own minute, shown from the list or after the shown one is forgotten", async () => {
    for (const how of ["select", "forget"] as const) {
      const studio = new FakeMac();
      studio.routes = [lan];
      studio.behave(lan, { kind: "silent" });
      const laptop = new FakeMac();
      laptop.routes = [{ kind: "lan", host: "laptop.local", port: 47820 }];
      laptop.behave(laptop.routes[0]!, { kind: "silent" });
      const effects = pairedWith(studio, [lan]);
      const laptopKeys = pairedWith(laptop);
      effects.macs.save(laptopKeys.macs.saved.get(laptop.id)!);
      effects.keys.stored.set(laptop.id, laptopKeys.keys.stored.get(laptop.id)!);
      effects.openSocket = (route, hostKey) => (route.host === "laptop.local" ? laptop : studio).openSocket(route, hostKey);
      const { manager } = start(studio, "wifi", effects);
      await advance(70_000);
      expect(manager.getState(), how).toMatchObject({ mac: { name: "Studio" }, why: "silent" });
      if (how === "select") manager.select(laptop.id);
      else await manager.forget(studio.id);
      await advance(4_010);
      expect(manager.getState(), how).toMatchObject({ kind: "waiting", mac: { id: laptop.id }, why: "unreachable" });
    }
  });

  it("stays not reachable through Try again", async () => {
    const mac = new FakeMac();
    mac.routes = [lan];
    mac.behave(lan, { kind: "silent" });
    const { manager, states } = start(mac, "wifi", pairedWith(mac, [lan]));
    await advance(70_000);
    expect(manager.getState()).toMatchObject({ why: "silent" });
    states.length = 0;
    const settled = manager.retry();
    await advance(4_000);
    await settled;
    expect(states.map((state) => [state.kind, "why" in state && state.why])).toEqual([
      ["connecting", "silent"],
      ["waiting", "silent"],
    ]);
  });

  it("keeps a reason the Mac gave, and Check Tailscale on cellular, past the minute", async () => {
    const mac = new FakeMac();
    mac.behave(tailnet, { kind: "silent" });
    const { manager } = start(mac, "cellular");
    await advance(4_000);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "tailnet" });
    await advance(120_000);
    expect(manager.getState()).toMatchObject({ why: "tailnet" });
    manager.setNetwork("wifi");
    mac.behave(lan, { kind: "answer" });
    await advance(10);
    mac.behave(lan, { kind: "down" });
    mac.behave(tailnet, { kind: "down" });
    mac.closeAll("update");
    await advance(120_000);
    expect(manager.getState()).toMatchObject({ why: "restarting" });
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
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: { why: "removed", macName: "Studio" } });
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
    await advance(3_000);
    manager.appState("active");
    await advance(10);
    expect(mac.sessions[0]!.closed).toBe(false);
    expect(mac.heard.filter((message) => message.t === "ping")).toHaveLength(2);
  });

  it("reconnects at once after more than a few seconds away, even when iOS held the app's timers", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const { manager, states } = start(mac);
    await advance(10);
    manager.appState("background");
    // Suspended JS runs no timers: the clock moves on, the grace timer never fires, the phase still says connected.
    vi.setSystemTime(Date.now() + 9_000);
    expect(manager.getState().kind).toBe("connected");
    states.length = 0;
    manager.appState("active");
    expect(manager.getState().kind).toBe("connecting");
    await advance(10);
    expect(mac.sessions[0]!.closed).toBe(true);
    expect(manager.getState()).toMatchObject({ kind: "connected", serial: 2 });
    expect(states[0]!.kind).toBe("connecting");
    expect(states.filter((state) => state.kind === "connected")).toHaveLength(1);
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

describe("saved Macs and retries", () => {
  it("publishes the saved list, so a Mac forgotten from the sheet leaves it even when another is shown", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const effects = pairedWith(mac);
    effects.macs.save({ id: "other", name: "Laptop", routes: [lan], lastRoute: null });
    const { manager } = start(mac, "wifi", effects);
    await advance(10);
    const before = manager.getMacs();
    expect(before.map((saved) => saved.name)).toEqual(["Studio", "Laptop"]);
    let heard = 0;
    manager.subscribe(() => heard++);
    await manager.forget("other");
    expect(heard).toBeGreaterThan(0);
    expect(manager.getMacs()).not.toBe(before);
    expect(manager.getMacs().map((saved) => saved.name)).toEqual(["Studio"]);
    expect(manager.getState()).toMatchObject({ kind: "connected", mac: { name: "Studio" } });
  });

  it("tries again now instead of at the next backoff step, and says when that attempt settled", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "down" });
    const { manager } = start(mac);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
    const dialed = mac.dials.length;
    mac.behave(lan, { kind: "answer", delayMs: 50 });
    let settled = false;
    const retry = manager.retry().then(() => (settled = true));
    expect(manager.getState().kind).toBe("connecting");
    await advance(20);
    expect(settled).toBe(false);
    await advance(40);
    await retry;
    expect(manager.getState().kind).toBe("connected");
    expect(mac.dials).toHaveLength(dialed + 1);
    await manager.retry();
    expect(mac.dials).toHaveLength(dialed + 1);
  });

  it("says when the Keychain lost the key the phone pairs with", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const effects = pairedWith(mac);
    effects.keys.stored.clear();
    const { manager } = start(mac, "wifi", effects);
    await advance(10);
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: { why: "key-lost", macName: "Studio" } });
  });
});

describe("pairing", () => {
  it("spends the code over the first route that answers and keeps the Mac", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const effects = effectsFor(mac);
    const { manager } = start(mac, "wifi", effects);
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: null });
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
    expect(await pairing).toEqual({ ok: false, message: "This code was already used or has expired. Show a new one on your Mac.", spent: true });
    expect(await manager.pair(mac.pairingUrl(Date.now() - 1))).toEqual({ ok: false, message: "This code has expired. Show a new one on your Mac.", spent: true });
    expect(await manager.pair("https://example.com")).toEqual({ ok: false, message: "This is not an OpenOrc pairing code.", spent: true });
    expect(effects.macs.saved.size).toBe(0);
    expect(effects.keys.stored.size).toBe(0);
    expect(manager.getState()).toEqual({ kind: "unpaired", lost: null });
  });

  it("spends a code a Mac of another version refused, and keeps one a busy Mac refused", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "refuse", reason: "incompatible" });
    mac.behave(tailnet, { kind: "down" });
    const { manager } = start(mac, "wifi", effectsFor(mac));
    const other = manager.pair(mac.pairingUrl());
    await advance(10);
    expect(await other).toMatchObject({ ok: false, spent: true });
    mac.behave(lan, { kind: "refuse", reason: "busy" });
    const busy = manager.pair(mac.pairingUrl());
    await advance(10);
    expect(await busy).toMatchObject({ ok: false, spent: false });
  });

  it("keeps a code it could not deliver, since the same code can pair once the Mac is reachable", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "down" });
    mac.behave(tailnet, { kind: "down" });
    const effects = effectsFor(mac);
    const { manager } = start(mac, "wifi", effects);
    const url = mac.pairingUrl();
    expect(await manager.pair(url)).toEqual({ ok: false, message: "Could not reach your Mac. Check that this phone is on its network or tailnet.", spent: false });
    mac.behave(lan, { kind: "answer" });
    const again = manager.pair(url);
    await advance(10);
    expect(await again).toMatchObject({ ok: true });
  });
});

describe("a cloud brain", () => {
  function brain() {
    const cloud = new FakeMac("Cloud");
    cloud.routes = [publicRoute];
    cloud.hostKind = "brain";
    cloud.behave(publicRoute, { kind: "answer" });
    return cloud;
  }

  it("is known by what it answers when asked, so a Mac reached only through a public address stays a Mac", async () => {
    const cloud = brain();
    const asBrain = start(cloud, "wifi", pairedWith(cloud));
    await advance(10);
    expect(asBrain.effects.macs.saved.get(cloud.id)).toMatchObject({ kind: "brain" });
    const proxied = brain();
    proxied.hostKind = "mac";
    const asMac = start(proxied, "wifi", pairedWith(proxied));
    await advance(10);
    expect(asMac.effects.macs.saved.get(proxied.id)).toMatchObject({ kind: "mac" });
  });

  it("reads a host from before the question as a Mac, and keeps what it saved when the session drops before an answer", async () => {
    const old = brain();
    old.hostKind = "unknown";
    const asOld = start(old, "wifi", pairedWith(old));
    await advance(10);
    expect(asOld.manager.getState()).toMatchObject({ kind: "connected" });
    expect(asOld.effects.macs.saved.get(old.id)).toMatchObject({ kind: "mac" });
    const cloud = brain();
    cloud.hostKind = "held";
    const effects = pairedWith(cloud);
    effects.macs.save({ ...effects.macs.saved.get(cloud.id)!, kind: "brain" });
    start(cloud, "wifi", effects);
    await advance(10);
    cloud.live[0]!.close(LinkCloseCode.normal);
    await advance(1_000);
    expect(effects.macs.saved.get(cloud.id)).toMatchObject({ kind: "brain" });
  });

  it("hears from a host which brains it removed, on each session; an older host says none", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    mac.removedBrains = ["brain-key"];
    const { effects } = start(mac, "wifi", pairedWith(mac));
    await advance(10);
    expect(effects.removed).toEqual([[mac.id, ["brain-key"]]]);
    const quiet = new FakeMac();
    quiet.behave(lan, { kind: "answer" });
    const none = start(quiet, "wifi", pairedWith(quiet));
    const old = new FakeMac();
    old.behave(lan, { kind: "answer" });
    old.removedBrains = "unknown";
    const asOld = start(old, "wifi", pairedWith(old));
    await advance(10);
    expect(asOld.manager.getState()).toMatchObject({ kind: "connected" });
    expect([...none.effects.removed, ...asOld.effects.removed]).toEqual([]);
  });

  it("forgets the brain its Mac removed, with its key and door, as the Mac's session starts", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    const cloud = brain();
    mac.removedBrains = [cloud.id];
    const effects = pairedWith(mac);
    effects.macs.save({ id: cloud.id, name: "Cloud", routes: [publicRoute], lastRoute: null, kind: "brain" });
    effects.keys.stored.set(cloud.id, new Uint8Array(32));
    const { manager } = start(mac, "wifi", effects);
    effects.brainsRemoved = forgetRemovedBrains(effects.macs, (id) => void manager.forget(id));
    await advance(10);
    expect([...effects.macs.saved.keys()]).toEqual([mac.id]);
    expect(effects.keys.stored.has(cloud.id)).toBe(false);
    expect(manager.getState()).toMatchObject({ kind: "connected", mac: { name: "Studio" } });
  });

  it("is reached from every network with internet, over the path its key names", async () => {
    for (const network of ["wifi", "cellular", "other"] as const) {
      const cloud = brain();
      const { manager } = start(cloud, network, pairedWith(cloud));
      await advance(10);
      expect(manager.getState(), network).toMatchObject({ kind: "connected", route: publicRoute, mac: { name: "Cloud" } });
    }
    const cloud = brain();
    const { manager } = start(cloud, "none", pairedWith(cloud));
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "offline", retryAt: null });
    expect(cloud.dials).toHaveLength(0);
  });

  it("tries a public route last: after the LAN and the tailnet, or after the tailnet on cellular", async () => {
    for (const [network, order] of [
      ["wifi", ["studio.local@0", "100.64.0.7@250", "sb-brain.vercel.run@500"]],
      ["cellular", ["100.64.0.7@0", "sb-brain.vercel.run@250"]],
    ] as const) {
      const host = new FakeMac();
      host.routes = [publicRoute, tailnet, lan];
      for (const route of host.routes) host.behave(route, { kind: "silent" });
      const from = Date.now();
      start(host, network, pairedWith(host));
      await advance(600);
      expect(
        host.dials.map(({ host: dialedHost, at }) => `${dialedHost}@${at - from}`),
        network,
      ).toEqual(order);
    }
  });

  it("reads asleep as a Mac that is away does: Reconnecting, then Not reachable, backing off, until it answers", async () => {
    const cloud = brain();
    // An asleep brain's address answers 502, so its socket never opens.
    cloud.behave(publicRoute, { kind: "down" });
    const { manager, states } = start(cloud, "cellular", pairedWith(cloud));
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
    await advance(65_000);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "silent" });
    expect(new Set(states.flatMap((state) => ("why" in state && state.why ? [state.why] : [])))).toEqual(new Set(["unreachable", "silent"]));
    expect(cloud.dials.length).toBeLessThanOrEqual(9);
    cloud.behave(publicRoute, { kind: "answer" });
    await advance(15_000);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: publicRoute });
  });

  const KEY = { host: "openorc-door-abcdefghijklmnop.vercel.app", device: "device-1", epoch: 685, ticket: "t" };
  const READY = { kind: "ready", route: publicRoute } as const;
  /** A brain asleep behind its proxy, and a phone that holds the key to its door. */
  function asleep(network: NetworkKind = "cellular") {
    const cloud = brain();
    cloud.behave(publicRoute, { kind: "down" });
    const effects = pairedWith(cloud);
    effects.doors.keys.set(cloud.id, KEY);
    return { cloud, ...start(cloud, network, effects) };
  }

  it("learns its key to the door on every session; a host with none forgets it, and one from before doors leaves it", async () => {
    const cloud = brain();
    cloud.doorKey = KEY;
    const { manager, effects } = start(cloud, "wifi", pairedWith(cloud));
    await advance(10);
    expect(effects.doors.keys.get(cloud.id)).toEqual(KEY);
    cloud.doorKey = "unknown";
    cloud.live[0]!.close(LinkCloseCode.normal);
    await advance(1_000);
    expect(manager.getState()).toMatchObject({ kind: "connected" });
    expect(effects.doors.keys.get(cloud.id)).toEqual(KEY);
    cloud.doorKey = null;
    cloud.live[0]!.close(LinkCloseCode.normal);
    await advance(1_000);
    expect(effects.doors.keys.has(cloud.id)).toBe(false);
  });

  it("knocks once the race finds nothing, says Waking while the brain wakes, then connects at once", async () => {
    const { cloud, manager, effects, states } = asleep();
    effects.doors.wake = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          cloud.behave(publicRoute, { kind: "answer" });
          resolve(READY);
        }, 9_000),
      );
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connecting", why: "waking" });
    await advance(9_100);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: publicRoute });
    expect(effects.doors.knocks).toEqual([cloud.id]);
    expect(states.map((state) => state.kind === "connecting" && state.why)).toContain("waking");
    expect(states.some((state) => state.kind === "waiting")).toBe(false);
  });

  it("knocks at most once a minute, never offline, and never on a host without a door", async () => {
    const { cloud, manager, effects } = asleep();
    effects.doors.wake = async () => ({ kind: "failed" });
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "wake-failed" });
    await advance(59_000);
    expect(effects.doors.knocks).toHaveLength(1);
    await advance(16_000);
    expect(effects.doors.knocks).toHaveLength(2);
    cloud.internet = "down";
    manager.setNetwork("other");
    await advance(70_000);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "offline" });
    expect(effects.doors.knocks).toHaveLength(2);

    const bare = brain();
    bare.behave(publicRoute, { kind: "down" });
    const plain = start(bare, "cellular", pairedWith(bare));
    await advance(10);
    expect(plain.manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
    expect(plain.effects.doors.knocks).toEqual([]);
  });

  it("says only the Mac can help when a brain with no door answers at its address with no brain behind it", async () => {
    const cloud = brain();
    cloud.behave(publicRoute, { kind: "http", status: 502 });
    // Known as a brain from when it was paired.
    const effects = pairedWith(cloud);
    effects.macs.save({ ...effects.macs.saved.get(cloud.id)!, kind: "brain" });
    const { manager } = start(cloud, "wifi", effects);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "needs-mac" });
    await advance(70_000);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "needs-mac" });
    // Its Mac starts the brain again, and the phone is back on its next try.
    cloud.behave(publicRoute, { kind: "answer" });
    await advance(16_000);
    expect(manager.getState()).toMatchObject({ kind: "connected" });
  });

  it("keeps reconnecting a brain whose address answers nothing, and a Mac whose address answers with no host", async () => {
    const quiet = brain();
    quiet.behave(publicRoute, { kind: "down" });
    const unanswered = start(quiet, "wifi", pairedWith(quiet)).manager;
    const proxied = brain();
    proxied.hostKind = "mac";
    proxied.behave(publicRoute, { kind: "http", status: 502 });
    const effects = pairedWith(proxied);
    effects.macs.save({ ...effects.macs.saved.get(proxied.id)!, kind: "mac" });
    const mac = start(proxied, "wifi", effects).manager;
    await advance(10);
    expect(unanswered.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
    expect(mac.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
  });

  it("says when the door will not take this phone, or only the Mac can help, until something answers", async () => {
    for (const [outcome, why] of [
      ["refused", "wake-refused"],
      ["needs-mac", "needs-mac"],
    ] as const) {
      const { cloud, manager, effects } = asleep();
      effects.doors.wake = async () => ({ kind: outcome });
      await advance(10);
      expect(manager.getState(), outcome).toMatchObject({ kind: "waiting", why });
      await advance(30_000);
      expect(manager.getState(), outcome).toMatchObject({ kind: "waiting", why });
      cloud.behave(publicRoute, { kind: "answer" });
      await advance(16_000);
      expect(manager.getState(), outcome).toMatchObject({ kind: "connected" });
    }
  });

  it("stops knocking on a door that refused this phone until the person is back, and goes on knocking for the Mac's sake", async () => {
    const refused = asleep();
    refused.effects.doors.wake = async () => ({ kind: "refused" });
    await advance(130_000);
    expect(refused.effects.doors.knocks).toHaveLength(1);
    refused.manager.appState("background");
    refused.manager.appState("active");
    await advance(10);
    expect(refused.effects.doors.knocks).toHaveLength(2);
    expect(refused.manager.getState()).toMatchObject({ kind: "waiting", why: "wake-refused" });

    const mac = asleep();
    mac.effects.doors.wake = async () => ({ kind: "needs-mac" });
    await advance(130_000);
    expect(mac.effects.doors.knocks.length).toBeGreaterThanOrEqual(2);
  });

  it("as the partner beside the shown Mac, knocks only while the person has one of its screens open", async () => {
    const cloud = brain();
    cloud.behave(publicRoute, { kind: "down" });
    const effects = pairedWith(cloud);
    effects.doors.keys.set(cloud.id, KEY);
    let opened = false;
    const { manager } = start(cloud, "cellular", { ...effects, doors: { ...effects.doors, ...doorsOnIntent(effects.doors, () => opened) } });
    await advance(130_000);
    expect(effects.doors.knocks).toEqual([]);
    expect(manager.getState()).toMatchObject({ kind: "waiting" });
    opened = true;
    await manager.retry();
    await advance(10);
    expect(effects.doors.knocks).toEqual([cloud.id]);
  });

  it("as the partner, dials with the key the phone holds now once it let the host go, as Forget and a new pairing leave it", async () => {
    const cloud = brain();
    const effects = pairedWith(cloud);
    const { manager } = start(cloud, "cellular", effects);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected" });
    manager.release();
    const fresh = nobleCrypto.generateKeyPair();
    cloud.paired.clear();
    cloud.paired.add(toBase64Url(fresh.publicKey));
    effects.keys.stored.set(cloud.id, fresh.privateKey);
    manager.select(cloud.id);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", mac: { id: cloud.id } });
    expect(effects.keys.stored.get(cloud.id)).toEqual(fresh.privateKey);
  });

  it("as the partner, dials with the key the phone holds now when it comes back to a host it showed before", async () => {
    const cloud = brain();
    const effects = pairedWith(cloud);
    effects.macs.save({ id: "AAAA", name: "Studio", routes: [], lastRoute: null });
    const { manager } = start(cloud, "cellular", effects);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected" });
    manager.select("AAAA");
    const fresh = nobleCrypto.generateKeyPair();
    cloud.paired.clear();
    cloud.paired.add(toBase64Url(fresh.publicKey));
    effects.keys.stored.set(cloud.id, fresh.privateKey);
    manager.select(cloud.id);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", mac: { id: cloud.id } });
    expect(effects.keys.stored.get(cloud.id)).toEqual(fresh.privateKey);
  });

  it("reads a host the door does not know of as it does without a door", async () => {
    const { manager, effects } = asleep();
    await advance(10);
    expect(effects.doors.knocks).toHaveLength(1);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
  });

  it("stops waiting on the door when the phone leaves, which wakes the brain all the same; Forget drops the key", async () => {
    const { cloud, manager, effects } = asleep();
    let signal: AbortSignal | null = null;
    effects.doors.wake = (_id, given) => {
      signal = given;
      return new Promise(() => undefined);
    };
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connecting", why: "waking" });
    manager.appState("background");
    await advance(21_000);
    expect(signal!.aborted).toBe(true);
    expect(manager.getState()).toMatchObject({ kind: "suspended" });
    await manager.forget(cloud.id);
    expect(effects.doors.keys.has(cloud.id)).toBe(false);
  });

  it("blames Tailscale on cellular only when every route tried was a tailnet route", async () => {
    const host = new FakeMac();
    host.routes = [tailnet, publicRoute];
    host.behave(tailnet, { kind: "down" });
    host.behave(publicRoute, { kind: "down" });
    const { manager } = start(host, "cellular", pairedWith(host));
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "waiting", why: "unreachable" });
  });

  it("pairs beside the Mac without losing it, and switches between the two", async () => {
    const studio = new FakeMac();
    studio.behave(lan, { kind: "answer" });
    const cloud = brain();
    const effects = pairedWith(studio);
    effects.openSocket = (route, hostKey) => (route.kind === "public" ? cloud : studio).openSocket(route, hostKey);
    const { manager } = start(studio, "wifi", effects);
    await advance(10);
    const pairing = manager.pair(cloud.pairingUrl());
    await advance(10);
    expect(await pairing).toEqual({ ok: true, mac: { id: cloud.id, name: "Cloud" } });
    expect(manager.getState()).toMatchObject({ kind: "connected", route: publicRoute, mac: { id: cloud.id, name: "Cloud" } });
    expect(manager.getMacs().map((saved) => saved.name)).toEqual(["Studio", "Cloud"]);
    expect([...effects.keys.stored.keys()]).toEqual([studio.id, cloud.id]);
    manager.select(studio.id);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan, mac: { id: studio.id } });
    manager.select(cloud.id);
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: publicRoute, mac: { id: cloud.id } });
    expect(cloud.paired.size).toBe(1);
    expect(studio.paired.size).toBe(1);
  });
});
