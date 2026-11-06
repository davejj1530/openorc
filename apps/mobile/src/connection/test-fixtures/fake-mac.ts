import {
  acceptLink,
  encodePairingUrl,
  LinkCloseCode,
  linkPath,
  toBase64Url,
  type Admission,
  type ClosingReason,
  type MacMessage,
  type MacSession,
  type PhoneHello,
  type PhoneMessage,
  type Refusal,
} from "@openorc/link";
import { nobleCrypto } from "@openorc/link/test-fixtures/noble-crypto";
import { socketPair } from "@openorc/link/test-fixtures/socket-pair";
import type { DoorKey, Route } from "@openorc/protocol";
import type { PhoneDoors, WakeOutcome } from "../door";
import type { ConnectionEffects, OpeningSocket } from "../manager";
import type { DeviceKeys, MacStore, SavedMac } from "../saved-macs";

/**
 * How one address behaves: a Mac that answers (after `delayMs`), declines, never answers, or nothing listening. `http`:
 * the address answers itself, as Agent37's does with `status` 502 for an instance with nothing on its port.
 */
export type Behavior = { kind: "answer"; delayMs?: number } | { kind: "refuse"; reason: Refusal } | { kind: "silent" } | { kind: "down" } | { kind: "http"; status: number };

export const lan: Route = { kind: "lan", host: "studio.local", port: 47820 };
export const lanAddress: Route = { kind: "lan", host: "192.168.1.20", port: 47820 };
export const tailnet: Route = { kind: "tailnet", host: "100.64.0.7", port: 47820 };
/** iOS gives up on a call that has heard nothing for a minute. */
const CALL_HELD_MS = 60_000;

/** A cloud brain's address behind Vercel's proxy. */
export const publicRoute: Route = { kind: "public", host: "sb-brain.vercel.run", port: 443 };

/**
 * A Mac for the phone's connection tests: the real handshake over in-memory sockets, with each address set to
 * answer, decline or stay silent. It answers pings unless `mute`, and records what it hears and every dial. Behind a
 * public route, as a cloud brain, it answers only on the path its own key names, as its proxied listener does.
 */
export class FakeMac {
  readonly keys = nobleCrypto.generateKeyPair();
  readonly id = toBase64Url(this.keys.publicKey);
  routes: Route[] = [lan, tailnet];
  readonly behaviors = new Map<string, Behavior>();
  readonly dials: Array<{ host: string; at: number }> = [];
  readonly sessions: MacSession[] = [];
  readonly heard: PhoneMessage[] = [];
  readonly paired = new Set<string>();
  offer: { offerId: string; secret: Uint8Array } | null = null;
  mute = false;
  /** How the internet answers the phone's check, as the network around this Mac would: at once, not at all, or never. */
  internet: "up" | "down" | "hung" = "up";
  internetChecks = 0;
  /** Answers a call, or holds it when this returns undefined. */
  answer: (method: string, params: unknown) => unknown = () => undefined;
  /** What it answers door.key with: a Mac has no door; "unknown" is a host from before doors. */
  doorKey: DoorKey | null | "unknown" = null;
  /** What it answers host.kind with: "unknown" is a host from before the question, and "held" never answers. */
  hostKind: "mac" | "brain" | "unknown" | "held" = "mac";
  /** The brains it says it removed; "unknown" is a host from before the question. */
  removedBrains: string[] | "unknown" = [];
  /**
   * Asleep behind a service that wakes it for a plain call to its address, `wakeMs` after the first, as Agent37 does.
   * Its link does not answer meanwhile.
   */
  asleep: { wakeMs: number } | null = null;
  /** Every plain call to its addresses, by host. */
  readonly calls: Array<{ host: string; at: number }> = [];
  private waking: Promise<void> | null = null;

  constructor(readonly name = "Studio") {}

  behave(route: Route, behavior: Behavior): void {
    this.behaviors.set(route.host, behavior);
  }

  get live(): MacSession[] {
    return this.sessions.filter((session) => !session.closed);
  }

  /** A single-use code, as remote.pairing.begin makes it. */
  pairingUrl(expiresAt = Date.now() + 5 * 60_000): string {
    this.offer = { offerId: "offer-1", secret: nobleCrypto.randomBytes(32) };
    return encodePairingUrl({ macName: this.name, macKey: this.keys.publicKey, offerId: this.offer.offerId, secret: this.offer.secret, routes: this.routes, expiresAt });
  }

  send(message: MacMessage): void {
    for (const session of this.live) session.send(message);
  }

  /** The Mac ends every session on purpose, saying why first. */
  closeAll(reason: ClosingReason): void {
    for (const session of this.live) {
      session.send({ t: "closing", reason });
      session.close(LinkCloseCode.closing, reason);
    }
  }

  reachesInternet(signal: AbortSignal): Promise<boolean> {
    this.internetChecks++;
    if (this.internet === "hung") return new Promise((resolve) => signal.addEventListener("abort", () => resolve(false)));
    return Promise.resolve(this.internet === "up");
  }

  /**
   * A plain GET to one of its addresses: a host's listener answers 404, an `http` address its status, and nothing
   * listening nothing. Asleep, the call wakes it and is held till then, as long as iOS waits.
   */
  callAddress(url: string, signal: AbortSignal): Promise<number | null> {
    const { host } = new URL(url);
    this.calls.push({ host, at: Date.now() });
    if (this.asleep)
      this.waking ??= new Promise((resolve) =>
        setTimeout(() => {
          this.asleep = null;
          this.waking = null;
          resolve();
        }, this.asleep!.wakeMs),
      );
    return new Promise((resolve) => {
      const give = (status: number | null) => {
        clearTimeout(held);
        signal.removeEventListener("abort", cut);
        resolve(status);
      };
      const cut = () => give(null);
      const held = setTimeout(cut, CALL_HELD_MS);
      signal.addEventListener("abort", cut, { once: true });
      const answer = () => {
        const behavior = this.behaviors.get(host) ?? { kind: "down" };
        if (behavior.kind === "down") give(null);
        else if (behavior.kind === "http") give(behavior.status);
        else if (behavior.kind !== "silent") give(404);
      };
      if (this.waking) void this.waking.then(answer);
      else answer();
    });
  }

  openSocket(route: Route, hostKey: Uint8Array): OpeningSocket {
    this.dials.push({ host: route.host, at: Date.now() });
    const ownPath = linkPath(route.kind, hostKey, nobleCrypto) === linkPath(route.kind, this.keys.publicKey, nobleCrypto);
    const behavior = (!this.asleep && ownPath && this.behaviors.get(route.host)) || { kind: this.asleep ? "silent" : "down" };
    if (behavior.kind === "down" || behavior.kind === "http") return { opened: Promise.reject(new Error("connection refused")), close: () => undefined };
    if (behavior.kind === "silent") return { opened: new Promise(() => undefined), close: () => undefined };
    const { phone, mac } = socketPair();
    void acceptLink({ socket: mac, crypto: nobleCrypto, local: this.keys, admit: (key, hello) => this.admit(key, hello, behavior) }).then((accepted) => {
      if (!accepted) return;
      this.sessions.push(accepted.session);
      accepted.session.onMessage((message) => {
        this.heard.push(message);
        if (message.t === "ping" && !this.mute) accepted.session.send({ t: "pong", id: message.id });
        if (message.t !== "rpc") return;
        if (message.method === "host.kind") {
          if (this.hostKind === "unknown") accepted.session.send({ t: "rpc.error", id: message.id, message: "This is not available from a phone." });
          else if (this.hostKind !== "held") accepted.session.send({ t: "rpc.result", id: message.id, result: this.hostKind });
          return;
        }
        if (message.method === "brains.removed") {
          if (this.removedBrains === "unknown") accepted.session.send({ t: "rpc.error", id: message.id, message: "This is not available from a phone." });
          else accepted.session.send({ t: "rpc.result", id: message.id, result: this.removedBrains });
          return;
        }
        if (message.method === "door.key") {
          if (this.doorKey === "unknown") accepted.session.send({ t: "rpc.error", id: message.id, message: "This is not available from a phone." });
          else accepted.session.send({ t: "rpc.result", id: message.id, result: this.doorKey });
          return;
        }
        const result = this.answer(message.method, message.params);
        if (result !== undefined) accepted.session.send({ t: "rpc.result", id: message.id, result });
      });
    });
    const delayMs = behavior.kind === "answer" ? (behavior.delayMs ?? 0) : 0;
    return { opened: new Promise((resolve) => setTimeout(() => resolve(phone), delayMs)), close: () => phone.close(LinkCloseCode.normal, "") };
  }

  private admit(key: Uint8Array, hello: PhoneHello, behavior: Behavior): Admission<null> {
    if (behavior.kind === "refuse") return { ok: false, reason: behavior.reason };
    const device = toBase64Url(key);
    if (!this.paired.has(device)) {
      const offer = this.offer;
      if (!hello.pair || !offer || hello.pair.offerId !== offer.offerId || hello.pair.secret !== toBase64Url(offer.secret)) return { ok: false, reason: hello.pair ? "offer-invalid" : "unpaired" };
      this.offer = null;
      this.paired.add(device);
    }
    return { ok: true, value: null, hello: { mac: { name: this.name }, deviceId: `device-${device.slice(0, 6)}`, routes: this.routes } };
  }
}

export function memoryMacs(initial: SavedMac[] = [], active: string | null = initial[0]?.id ?? null): MacStore & { saved: Map<string, SavedMac> } {
  const saved = new Map(initial.map((mac) => [mac.id, mac]));
  let activeId = active;
  return {
    saved,
    list: () => [...saved.values()],
    activeId: () => activeId,
    setActiveId: (id) => (activeId = id),
    save: (mac) => void saved.set(mac.id, mac),
    remove: (id) => void saved.delete(id),
  };
}

export function memoryKeys(): DeviceKeys & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    read: async (macId) => stored.get(macId) ?? null,
    write: async (macId, privateKey) => void stored.set(macId, privateKey),
    remove: async (macId) => void stored.delete(macId),
  };
}

/** Hosts' doors as the manager uses them: the keys learned, and each knock answered with what `wake` says. */
export function memoryDoors(): PhoneDoors & { keys: Map<string, DoorKey>; knocks: string[]; wake: (macId: string, signal: AbortSignal) => Promise<WakeOutcome> } {
  const keys = new Map<string, DoorKey>();
  const knocks: string[] = [];
  const doors: ReturnType<typeof memoryDoors> = {
    keys,
    knocks,
    wake: async () => ({ kind: "unanswered" }),
    learn: async (macId: string, key: DoorKey | null) => void (key ? keys.set(macId, key) : keys.delete(macId)),
    has: async (macId: string) => keys.has(macId),
    knock: (macId: string, signal: AbortSignal) => {
      knocks.push(macId);
      return doors.wake(macId, signal);
    },
    forget: async (macId: string) => void keys.delete(macId),
  };
  return doors;
}

/** Effects for a manager talking to `mac`, on timers vitest fakes. */
export function effectsFor(
  mac: FakeMac,
  macs = memoryMacs(),
  keys = memoryKeys(),
): ConnectionEffects & {
  macs: ReturnType<typeof memoryMacs>;
  keys: ReturnType<typeof memoryKeys>;
  doors: ReturnType<typeof memoryDoors>;
  forgotten: string[];
  removed: [string, readonly string[]][];
} {
  const forgotten: string[] = [];
  const removed: [string, readonly string[]][] = [];
  return {
    openSocket: (route, hostKey) => mac.openSocket(route, hostKey),
    crypto: nobleCrypto,
    clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    random: () => 0.5,
    macs,
    keys,
    deviceName: "Test iPhone",
    forgetCache: (id) => void forgotten.push(id),
    reachesInternet: (signal) => mac.reachesInternet(signal),
    callAddress: (url, signal) => mac.callAddress(url, signal),
    mayWake: () => true,
    doors: memoryDoors(),
    brainsRemoved: (macId, ids) => void removed.push([macId, ids]),
    forgotten,
    removed,
  };
}

/** A phone already paired with `mac`: its saved record, its key, and the Mac knowing that key. */
export function pairedWith(mac: FakeMac, routes: Route[] = mac.routes): ReturnType<typeof effectsFor> {
  const device = nobleCrypto.generateKeyPair();
  mac.paired.add(toBase64Url(device.publicKey));
  const effects = effectsFor(mac, memoryMacs([{ id: mac.id, name: mac.name, routes, lastRoute: null }]));
  effects.keys.stored.set(mac.id, device.privateKey);
  return effects;
}
