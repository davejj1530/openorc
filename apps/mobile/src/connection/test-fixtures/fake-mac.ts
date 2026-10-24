import {
  acceptLink,
  encodePairingUrl,
  LinkCloseCode,
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
import type { Route } from "@openorc/protocol";
import type { ConnectionEffects, OpeningSocket } from "../manager";
import type { DeviceKeys, MacStore, SavedMac } from "../saved-macs";

/** How one address behaves: a Mac that answers (after `delayMs`), declines, never answers, or nothing listening. */
export type Behavior = { kind: "answer"; delayMs?: number } | { kind: "refuse"; reason: Refusal } | { kind: "silent" } | { kind: "down" };

export const lan: Route = { kind: "lan", host: "studio.local", port: 47820 };
export const lanAddress: Route = { kind: "lan", host: "192.168.1.20", port: 47820 };
export const tailnet: Route = { kind: "tailnet", host: "100.64.0.7", port: 47820 };

/**
 * A Mac for the phone's connection tests: the real handshake over in-memory sockets, with each address set to
 * answer, decline or stay silent. It answers pings unless `mute`, and records what it hears and every dial.
 */
export class FakeMac {
  readonly keys = nobleCrypto.generateKeyPair();
  readonly id = toBase64Url(this.keys.publicKey);
  readonly name = "Studio";
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

  openSocket(route: Route): OpeningSocket {
    this.dials.push({ host: route.host, at: Date.now() });
    const behavior = this.behaviors.get(route.host) ?? { kind: "down" };
    if (behavior.kind === "down") return { opened: Promise.reject(new Error("connection refused")), close: () => undefined };
    if (behavior.kind === "silent") return { opened: new Promise(() => undefined), close: () => undefined };
    const { phone, mac } = socketPair();
    void acceptLink({ socket: mac, crypto: nobleCrypto, local: this.keys, admit: (key, hello) => this.admit(key, hello, behavior) }).then((accepted) => {
      if (!accepted) return;
      this.sessions.push(accepted.session);
      accepted.session.onMessage((message) => {
        this.heard.push(message);
        if (message.t === "ping" && !this.mute) accepted.session.send({ t: "pong", id: message.id });
        if (message.t !== "rpc") return;
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

/** Effects for a manager talking to `mac`, on timers vitest fakes. */
export function effectsFor(
  mac: FakeMac,
  macs = memoryMacs(),
  keys = memoryKeys(),
): ConnectionEffects & { macs: ReturnType<typeof memoryMacs>; keys: ReturnType<typeof memoryKeys>; forgotten: string[] } {
  const forgotten: string[] = [];
  return {
    openSocket: (route) => mac.openSocket(route),
    crypto: nobleCrypto,
    clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    random: () => 0.5,
    macs,
    keys,
    deviceName: "Test iPhone",
    forgetCache: (id) => void forgotten.push(id),
    reachesInternet: (signal) => mac.reachesInternet(signal),
    forgotten,
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
