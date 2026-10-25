import type { ClientPush } from "@openorc/client";
import type { PushEnvironment, PushRegistration, PushSenderState, PushSenderStates } from "@openorc/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { PhoneAlerts, type PushPlatform } from "./alerts";
import type { Permission } from "./registration";

const studio = { id: "studio", name: "Studio" };
const route = { kind: "lan", host: "studio.local", port: 47820 } as const;
const token = "ab".repeat(32);
const NOT_FROM_PHONE = "This is not available from a phone.";

/** One state stands for both hosts. */
type Answer = PushSenderState | PushSenderStates | Error | "never";

/** A phone with its link, iOS and MMKV stood in: what it registered, with which Mac, and what it asked iOS. */
function phone(options: { permission?: Permission; grant?: Permission; answer?: Answer; saved?: Map<string, string>; token?: Promise<string>; environment?: PushEnvironment } = {}) {
  let permission: Permission = options.permission ?? "granted";
  let state: LinkState = { kind: "connecting", mac: studio, why: null };
  let answer: Answer = options.answer ?? "ready";
  let tokenListener: (next: string) => void = () => undefined;
  let pushListener: (push: ClientPush) => void = () => undefined;
  const listeners = new Set<() => void>();
  const sent: { macId: string; registration: PushRegistration | null }[] = [];
  const order: string[] = [];
  const asked: Permission[] = [];
  const saved = options.saved ?? new Map<string, string>();
  const platform: PushPlatform = {
    permission: async () => permission,
    ask: async () => {
      permission = options.grant ?? "granted";
      asked.push(permission);
      return permission;
    },
    environment: async () => options.environment ?? "sandbox",
    token: () => options.token ?? Promise.resolve(token),
    onToken: (listener) => {
      tokenListener = listener;
      return () => undefined;
    },
  };
  const alerts = new PhoneAlerts({
    link: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState: () => state,
      forget: async (id) => void order.push(`forget ${id}`),
      connection: {
        device: (_method, { registration }) => {
          if (state.kind !== "connected") throw new Error("no session in this test");
          sent.push({ macId: state.mac.id, registration });
          order.push(registration ? "register" : "unregister");
          if (answer === "never") return new Promise(() => undefined);
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve(typeof answer === "string" ? { sandbox: answer, production: answer } : answer);
        },
        onPush: (listener) => {
          pushListener = listener;
          return () => undefined;
        },
      },
    },
    platform,
    storage: { getString: (key) => saved.get(key), set: (key, value) => void saved.set(key, value) },
  });
  alerts.start();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    alerts,
    sent,
    order,
    asked,
    saved,
    connect(serial: number, mac = studio) {
      state = { kind: "connected", mac, route, serial };
      emit();
    },
    drop() {
      state = { kind: "waiting", mac: studio, why: "unreachable", retryAt: null };
      emit();
    },
    answerWith: (next: Answer) => void (answer = next),
    iosSays: (next: Permission) => void (permission = next),
    newToken: (next: string) => tokenListener(next),
    hears: (keys: string[]) => pushListener({ type: "invalidate", keys }),
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const registration = (overrides: Partial<PushRegistration> = {}): PushRegistration => ({ token, environment: "sandbox", alerts: "all", sound: true, ...overrides });

afterEach(() => void vi.useRealTimers());

describe("registering with the Mac", () => {
  it("tells each new session with the shown Mac what this phone wants, once", async () => {
    const iphone = phone();
    iphone.connect(1);
    await settle();
    iphone.connect(1);
    await settle();
    expect(iphone.sent).toEqual([{ macId: "studio", registration: registration() }]);
    iphone.drop();
    iphone.connect(2, { id: "laptop", name: "Laptop" });
    await settle();
    expect(iphone.sent.at(-1)).toEqual({ macId: "laptop", registration: registration() });
    expect(iphone.sent).toHaveLength(2);
  });

  it("stops alerts when they are off here or in iOS", async () => {
    const off = phone({ saved: new Map([["notifications", JSON.stringify({ choice: "off", sound: true, asked: false })]]) });
    off.connect(1);
    const denied = phone({ permission: "denied" });
    denied.connect(1);
    await settle();
    expect(off.sent).toEqual([{ macId: "studio", registration: null }]);
    expect(denied.sent).toEqual([{ macId: "studio", registration: null }]);
  });

  it("sends a change of choice, sound or token to the shown Mac at once, and leaves the rest to the next session", async () => {
    const iphone = phone();
    iphone.connect(1);
    await settle();
    await iphone.alerts.choose("needs-you");
    await iphone.alerts.setSound(false);
    iphone.newToken("cd".repeat(32));
    await settle();
    expect(iphone.sent.slice(1).map((sent) => sent.registration)).toEqual([
      registration({ alerts: "needs-you" }),
      registration({ alerts: "needs-you", sound: false }),
      registration({ token: "cd".repeat(32), alerts: "needs-you", sound: false }),
    ]);
    await iphone.alerts.choose("off");
    expect(iphone.sent.at(-1)!.registration).toBeNull();
    iphone.drop();
    await iphone.alerts.choose("all");
    expect(iphone.sent).toHaveLength(5);
    iphone.connect(2);
    await settle();
    expect(iphone.sent.at(-1)!.registration).toEqual(registration({ token: "cd".repeat(32), sound: false }));
  });

  it("hears when iOS Settings changed while the app was away", async () => {
    const iphone = phone();
    iphone.connect(1);
    await settle();
    iphone.iosSays("denied");
    await iphone.alerts.refresh();
    expect(iphone.sent.at(-1)!.registration).toBeNull();
    expect(iphone.alerts.getState().permission).toBe("denied");
    await iphone.alerts.refresh();
    expect(iphone.sent).toHaveLength(2);
  });
});

describe("this launch's token", () => {
  it("never holds up what iOS said, and registers once the token comes", async () => {
    let arrive: (token: string) => void = () => undefined;
    const iphone = phone({ token: new Promise((resolve) => (arrive = resolve)) });
    iphone.connect(1);
    await settle();
    expect(iphone.alerts.getState().permission).toBe("granted");
    // The Mac keeps what it holds from an earlier launch: no token yet is not a reason to stop alerts.
    expect(iphone.sent).toEqual([]);
    arrive(token);
    await settle();
    expect(iphone.sent).toEqual([{ macId: "studio", registration: registration() }]);
  });
});

describe("asking iOS", () => {
  it("asks once, on the first session with a Mac that can send, then registers the token", async () => {
    const iphone = phone({ permission: "undetermined", answer: "no-key" });
    iphone.connect(1);
    await settle();
    expect(iphone.asked).toEqual([]);
    iphone.answerWith("ready");
    iphone.connect(2);
    await settle();
    expect(iphone.asked).toEqual(["granted"]);
    expect(iphone.sent.map((sent) => sent.registration)).toEqual([null, null, registration()]);
    iphone.connect(3);
    await settle();
    expect(iphone.asked).toHaveLength(1);
  });

  it("hears the Mac become able to send within a session: says so, and asks then", async () => {
    const iphone = phone({ permission: "undetermined", answer: "no-key" });
    iphone.connect(1);
    await settle();
    expect(iphone.alerts.getState().senders.get("studio")).toBe("no-key");
    iphone.answerWith("ready");
    iphone.hears(["remote"]);
    await settle();
    expect(iphone.sent).toHaveLength(1);
    iphone.hears(["remote", "push.sender"]);
    await settle();
    expect(iphone.alerts.getState().senders.get("studio")).toBe("ready");
    expect(iphone.asked).toEqual(["granted"]);
    expect(iphone.sent.map((sent) => sent.registration)).toEqual([null, null, registration()]);
    iphone.answerWith("refused");
    iphone.hears(["remote", "push.sender"]);
    await settle();
    expect(iphone.alerts.getState().senders.get("studio")).toBe("refused");
    expect(iphone.asked).toHaveLength(1);
  });

  it("hears its own build's host before it has registered, so a refusal on the other host never stops the one ask", async () => {
    const answer = { sandbox: "ready", production: "refused" } as const;
    const xcodeBuild = phone({ permission: "undetermined", answer });
    const storeBuild = phone({ permission: "undetermined", answer, environment: "production" });
    xcodeBuild.connect(1);
    storeBuild.connect(1);
    await settle();
    expect(xcodeBuild.sent[0]).toEqual({ macId: "studio", registration: null });
    expect(xcodeBuild.alerts.getState().senders.get("studio")).toBe("ready");
    expect(xcodeBuild.asked).toEqual(["granted"]);
    expect(xcodeBuild.sent.at(-1)!.registration).toEqual(registration());
    expect(storeBuild.alerts.getState().senders.get("studio")).toBe("refused");
    expect(storeBuild.asked).toEqual([]);
  });

  it("never asks on its own again, even after a relaunch, once the person answered", async () => {
    const saved = new Map<string, string>();
    const first = phone({ permission: "undetermined", grant: "denied", saved });
    first.connect(1);
    await settle();
    expect(first.asked).toEqual(["denied"]);
    const again = phone({ permission: "undetermined", saved });
    again.connect(1);
    await settle();
    expect(again.asked).toEqual([]);
    expect(again.sent).toEqual([{ macId: "studio", registration: null }]);
  });

  it("asks first when the person picks alerts iOS has not allowed yet", async () => {
    const iphone = phone({ permission: "undetermined", answer: "no-key" });
    iphone.connect(1);
    await settle();
    await iphone.alerts.choose("needs-you");
    expect(iphone.asked).toEqual(["granted"]);
    expect(iphone.sent.at(-1)!.registration).toEqual(registration({ alerts: "needs-you" }));
  });
});

describe("what the Mac said", () => {
  it("keeps each Mac's answer, and reads a Mac without phone alerts as one to update", async () => {
    const iphone = phone({ answer: "no-key" });
    iphone.connect(1);
    await settle();
    expect(iphone.alerts.getState().senders.get("studio")).toBe("no-key");
    // A dropped session or a slow Mac says nothing about what it can do.
    iphone.answerWith(new Error("The connection to your Mac dropped before it answered."));
    iphone.connect(2);
    await settle();
    expect(iphone.alerts.getState().senders.get("studio")).toBe("no-key");
    iphone.answerWith(new Error(NOT_FROM_PHONE));
    iphone.connect(3);
    await settle();
    expect(iphone.alerts.getState().senders.get("studio")).toBe("update");
  });
});

describe("forgetting a Mac", () => {
  it("stops its alerts first, so it never sends what this phone can no longer read", async () => {
    const iphone = phone();
    iphone.connect(1);
    await settle();
    await iphone.alerts.forget("studio");
    expect(iphone.order).toEqual(["register", "unregister", "forget studio"]);
  });

  it("waits at most 2 s for the Mac to hear it", async () => {
    const iphone = phone();
    iphone.connect(1);
    await settle();
    vi.useFakeTimers();
    iphone.answerWith("never");
    const forgetting = iphone.alerts.forget("studio");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(iphone.order).toEqual(["register", "unregister"]);
    await vi.advanceTimersByTimeAsync(1);
    await forgetting;
    expect(iphone.order.at(-1)).toBe("forget studio");
  });

  it("forgets a Mac it is not connected to at once", async () => {
    const iphone = phone();
    await iphone.alerts.forget("laptop");
    expect(iphone.order).toEqual(["forget laptop"]);
  });
});
