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
      effects.openSocket = (route) => (route.host === "laptop.local" ? laptop : studio).openSocket(route);
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
