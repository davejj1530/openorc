import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainSelf } from "@openorc/cloud";
import { AWAKE, BrainAwake, decide, type AwakeAction, type AwakeState } from "./awake.js";

const MIN = 60_000;
const T = 1_000_000_000;

const fresh: AwakeState = { lastBusyAt: T, expiresAt: null, capped: false };
const extend: AwakeAction = { kind: "extend", forMs: 10 * MIN };

describe("decide", () => {
  it.each<{ when: string; state: AwakeState; now: number; busy: string | null; action: AwakeAction; lastBusyAt: number; next: number }>([
    { when: "just woken and idle", state: fresh, now: T, busy: null, action: extend, lastBusyAt: T, next: T + MIN },
    { when: "busy", state: fresh, now: T + 9 * MIN, busy: "phones", action: extend, lastBusyAt: T + 9 * MIN, next: T + 10 * MIN },
    { when: "idle under five minutes", state: fresh, now: T + 5 * MIN - 1, busy: null, action: extend, lastBusyAt: T, next: T + 6 * MIN - 1 },
    { when: "idle five minutes since the start", state: fresh, now: T + 5 * MIN, busy: null, action: { kind: "sleep", why: "idle" }, lastBusyAt: T, next: T + 6 * MIN },
    {
      when: "idle five minutes since the last busy moment",
      state: { ...fresh, lastBusyAt: T + 20 * MIN },
      now: T + 25 * MIN,
      busy: null,
      action: { kind: "sleep", why: "idle" },
      lastBusyAt: T + 20 * MIN,
      next: T + 26 * MIN,
    },
    {
      when: "capped and idle",
      state: { lastBusyAt: T, expiresAt: T + 8 * MIN, capped: true },
      now: T + MIN,
      busy: null,
      action: { kind: "sleep", why: "session-limit" },
      lastBusyAt: T,
      next: T + 2 * MIN,
    },
    {
      when: "capped and busy, well before the stop",
      state: { lastBusyAt: T, expiresAt: T + 8 * MIN, capped: true },
      now: T + MIN,
      busy: "agents",
      action: { kind: "wait" },
      lastBusyAt: T + MIN,
      next: T + 2 * MIN,
    },
    {
      when: "capped and busy, under a tick from the last call",
      state: { lastBusyAt: T, expiresAt: T + 8 * MIN, capped: true },
      now: T + 6.5 * MIN,
      busy: "agents",
      action: { kind: "wait" },
      lastBusyAt: T + 6.5 * MIN,
      next: T + 7 * MIN,
    },
    {
      when: "capped and busy at the last call",
      state: { lastBusyAt: T, expiresAt: T + 8 * MIN, capped: true },
      now: T + 7 * MIN,
      busy: "agents",
      action: { kind: "sleep", why: "session-limit" },
      lastBusyAt: T + 7 * MIN,
      next: T + 8 * MIN,
    },
  ])("$when", ({ state, now, busy, action, lastBusyAt, next }) => {
    expect(decide(state, { now, busy }, AWAKE)).toEqual({ state: { ...state, lastBusyAt }, action, next });
  });
});

describe("BrainAwake", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function awake(options: { busy?: () => string | null; extend?: BrainSelf["extend"]; naps?: { stop: BrainSelf["stop"] } } = {}) {
    vi.useFakeTimers({ now: T });
    const extends_: number[] = [];
    const sleeps: string[] = [];
    const warnings: string[] = [];
    const self: BrainSelf = {
      extend:
        options.extend ??
        (async (forMs) => {
          extends_.push(Date.now());
          return { expiresAt: Date.now() + forMs, capped: false };
        }),
      stop: options.naps?.stop ?? (async () => undefined),
      region: async () => "sin1",
      ...(options.naps ? { keepsProcesses: true as const } : {}),
    };
    const brain = new BrainAwake({
      busy: options.busy ?? (() => null),
      self,
      sleep: async (why) => {
        sleeps.push(why);
        brain.stop();
      },
      warn: (text) => warnings.push(text),
    });
    return { brain, extends_, sleeps, warnings };
  }

  it("extends at once and every minute, then sleeps five idle minutes after the start", async () => {
    const { brain, extends_, sleeps } = awake();
    brain.start();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(extends_).toEqual([T, T + MIN, T + 2 * MIN, T + 3 * MIN, T + 4 * MIN]);
    expect(sleeps).toEqual(["idle"]);
  });

  it("starts the idle clock again on every request", async () => {
    const { brain, sleeps } = awake();
    brain.start();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    brain.touch();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(sleeps).toEqual([]);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(sleeps).toEqual(["idle"]);
  });

  it("stays up while busy", async () => {
    let busy: string | null = "phones";
    const { brain, sleeps } = awake({ busy: () => busy });
    brain.start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(sleeps).toEqual([]);
    busy = null;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sleeps).toEqual(["idle"]);
  });

  it("says once that it cannot extend, however often it fails", async () => {
    const { brain, warnings } = awake({
      busy: () => "agents",
      extend: async () => {
        throw new Error("Vercel is unreachable");
      },
    });
    brain.start();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(warnings).toEqual(["Could not keep the brain awake: Vercel is unreachable"]);
  });

  it("closes a busy brain a minute before a capped stop", async () => {
    const { brain, sleeps } = awake({ busy: () => "agents", extend: async () => ({ expiresAt: T + 3.5 * MIN, capped: true }) });
    brain.start();
    await vi.advanceTimersByTimeAsync(2.5 * MIN - 1);
    expect(sleeps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeps).toEqual(["session-limit"]);
  });

  it("sleeps a machine that keeps its process without closing the brain, and starts the idle clock over once the sleep answers", async () => {
    const stops: number[] = [];
    let woke: () => void = () => undefined;
    const { brain, sleeps } = awake({ naps: { stop: () => (stops.push(Date.now()), new Promise<void>((resolve) => (woke = resolve))) } });
    brain.start();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(stops).toEqual([T + 5 * MIN]);
    // Asleep for half a minute: the call answers once the machine woke, and the next look is on time.
    await vi.advanceTimersByTimeAsync(MIN / 2);
    woke();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(stops).toEqual([T + 5 * MIN]);
    await vi.advanceTimersByTimeAsync(MIN / 2);
    expect(stops).toEqual([T + 5 * MIN, T + 11 * MIN]);
    expect(sleeps).toEqual([]);
    brain.stop();
  });

  it("starts the idle clock over at a look long after it was due, as when the sleep answered before the machine slept", async () => {
    const stops: number[] = [];
    const { brain, extends_, sleeps } = awake({ naps: { stop: async () => void stops.push(Date.now()) } });
    brain.start();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(stops).toEqual([T + 5 * MIN]);
    // Asleep for two hours, its timers held: the next look comes that much late.
    vi.setSystemTime(T + 125 * MIN);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(stops).toEqual([T + 5 * MIN]);
    expect(extends_.at(-1)).toBe(T + 126 * MIN);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(stops).toEqual([T + 5 * MIN, T + 131 * MIN]);
    expect(sleeps).toEqual([]);
    brain.stop();
  });
});
