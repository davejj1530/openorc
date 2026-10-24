import {
  connectLink,
  decodePairingUrl,
  fromBase64Url,
  LinkCloseCode,
  toBase64Url,
  type ClosingReason,
  type KeyPair,
  type LinkCrypto,
  type LinkSocket,
  type MacGreeting,
  type MacMessage,
  type PairingOffer,
  type PhoneHello,
  type PhoneSession,
  type Refusal,
} from "@openorc/link";
import type { Route } from "@openorc/protocol";
import { LinkConnection } from "./link-connection";
import { raceRoutes, ROUTE_TIMEOUT_MS, type Attempt, type Clock, type RaceResult } from "./route-race";
import { learnRoutes, routesFor, type DeviceKeys, type MacStore, type NetworkKind, type SavedMac } from "./saved-macs";

/** Why the phone is not connected to the Mac it shows, as far as it knows. */
export type DownReason = "unreachable" | "offline" | "restarting" | "disabled" | "busy";

export interface MacName {
  id: string;
  name: string;
}

/** Why the phone has no Mac any more: the Mac removed it, or the Keychain lost the key it pairs with. */
export type LostMac = { why: "removed" | "key-lost"; macName: string };

/** The phone's connection to the Mac it shows: one state at a time, so a screen never reconciles flags. */
export type LinkState =
  /** `lost` says why the last Mac went, when it was not the person's own Forget. */
  | { kind: "unpaired"; lost: LostMac | null }
  /** `why` is what ended the last session or attempt, kept so a retry does not flicker the screen. */
  | { kind: "connecting"; mac: MacName; why: DownReason | null }
  /** `serial` counts the sessions: each new one, on any route, has a new serial, so a call that failed can tell. */
  | { kind: "connected"; mac: MacName; route: Route; serial: number }
  /** Trying again at `retryAt`, or once there is a network when it is null. */
  | { kind: "waiting"; mac: MacName; why: DownReason; retryAt: number | null }
  /** Closed after a while in the background; reconnects when the app comes back. */
  | { kind: "suspended"; mac: MacName }
  | { kind: "incompatible"; mac: MacName };

/** The state with what each one holds: the session while connected. The Mac's name comes from the store. */
type Phase =
  | { kind: "unpaired"; lost: LostMac | null }
  | { kind: "connecting"; why: DownReason | null }
  | Live
  | { kind: "waiting"; why: DownReason; retryAt: number | null }
  | { kind: "suspended" }
  | { kind: "incompatible" };
type Live = { kind: "connected"; route: Route; session: PhoneSession; serial: number };

/** A socket being opened. `close` also abandons one that has not opened yet. */
export interface OpeningSocket {
  opened: Promise<LinkSocket>;
  close(): void;
}

export interface ConnectionEffects {
  openSocket(route: Route): OpeningSocket;
  crypto: LinkCrypto;
  clock: Clock;
  random(): number;
  macs: MacStore;
  keys: DeviceKeys;
  deviceName: string;
  /** Deletes what the app cached for a Mac it forgets. */
  forgetCache(macId: string): void;
}

/** `spent` when the same code can never pair: the Mac refused it, it expired, or it is not a pairing code. */
export type PairResult = { ok: true; mac: MacName } | { ok: false; message: string; spent: boolean };

type Linked = { session: PhoneSession; hello: MacGreeting };

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];
const BACKOFF_CAP_MS = 15_000;
/** The Mac ends a session it has not heard from in 45 s. */
const PING_EVERY_MS = 20_000;
const PONG_WITHIN_MS = 10_000;
const BACKGROUND_GRACE_MS = 20_000;
/**
 * Back after this long, the session is not trusted: iOS suspends the app's timers and sockets a few seconds into the
 * background, so the grace timer may never have fired and the socket may be dead while the phase still says connected.
 */
const STALE_AFTER_MS = 5_000;
/** How long a session replaced by a better route keeps answering calls already sent over it. */
const DRAIN_MS = 5_000;

const closingReasons: ReadonlySet<string> = new Set<ClosingReason>(["update", "shutdown", "removed", "disabled"]);

const refusalWords: Record<Refusal, string> = {
  unpaired: "Your Mac does not know this phone. Show a new code on your Mac.",
  "offer-invalid": "This code was already used or has expired. Show a new one on your Mac.",
  incompatible: "This Mac runs another version of OpenOrc. Update both, then pair again.",
  busy: "Your Mac has too many phones connected. Try again in a moment.",
};

export function backoffMs(attempt: number, random: () => number): number {
  return BACKOFF_MS[attempt] ?? BACKOFF_CAP_MS * (0.8 + 0.4 * random());
}

/**
 * Keeps the phone connected to the Mac it shows: races the Mac's routes, pings while connected, reconnects with
 * backoff, closes in the background and reconnects in the foreground, moves to the LAN when Wi-Fi returns, and acts
 * on the Mac's reasons for closing. Calls and pushes go through `connection`.
 */
export class ConnectionManager {
  readonly connection: LinkConnection;
  private phase: Phase = { kind: "unpaired", lost: null };
  private state: LinkState = { kind: "unpaired", lost: null };
  private saved: SavedMac[];
  /** Bumped whenever work in flight stops mattering: a race that finishes for an old epoch closes what it made. */
  private epoch = 0;
  private attempt = 0;
  private sessions = 0;
  private network: NetworkKind = "other";
  private closing: ClosingReason | null = null;
  private pingId = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private backgroundTimer: unknown = null;
  private backgroundedAt: number | null = null;
  private readonly keyPairs = new Map<string, KeyPair>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly effects: ConnectionEffects) {
    this.connection = new LinkConnection(effects.clock, () => this.phase.kind !== "unpaired" && this.phase.kind !== "incompatible");
    this.saved = effects.macs.list();
  }

  getState = (): LinkState => this.state;

  /** The saved Macs, as one value that changes whenever one is saved or forgotten, so a screen can follow the list. */
  getMacs = (): readonly SavedMac[] => this.saved;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Connects to the Mac the app showed last, if any. */
  start(network: NetworkKind): void {
    this.network = network;
    if (this.active()) this.connectNow(null);
    else this.enter({ kind: "unpaired", lost: null });
  }

  /**
   * Tries the shown Mac again now instead of at the next backoff step, when the phone is not connected; resolves once
   * that attempt has settled. A session already up, or one on its way, is left alone.
   */
  retry(): Promise<void> {
    const phase = this.phase;
    if (phase.kind === "waiting" || phase.kind === "suspended" || phase.kind === "incompatible") this.retryNow(phase.kind === "waiting" ? phase.why : null);
    return this.settled();
  }

  /** Resolves once the phone is not on its way to the Mac. */
  private settled(): Promise<void> {
    if (this.phase.kind !== "connecting") return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        if (this.phase.kind === "connecting") return;
        stop();
        resolve();
      });
    });
  }

  /** Scans a pairing code: spends it over the first route that answers and makes that Mac the one shown. */
  async pair(url: string): Promise<PairResult> {
    let offer: PairingOffer;
    try {
      offer = decodePairingUrl(url.trim());
    } catch {
      return { ok: false, message: "This is not an OpenOrc pairing code.", spent: true };
    }
    if (offer.expiresAt <= this.effects.clock.now()) return { ok: false, message: "This code has expired. Show a new one on your Mac.", spent: true };
    const id = toBase64Url(offer.macKey);
    const saved = this.effects.macs.list().find((mac) => mac.id === id);
    const key = (await this.keyPair(id)) ?? this.effects.crypto.generateKeyPair();
    const pair = { offerId: offer.offerId, secret: toBase64Url(offer.secret) };
    const routes = routesFor({ routes: offer.routes, lastRoute: null }, this.network === "none" ? "other" : this.network);
    const result = await raceRoutes(routes, (route) => this.dial(route, offer.macKey, key, pair), this.effects.clock, closeLinked);
    if (!result.ok) return pairFailure(result.refused);
    await this.effects.keys.write(id, key.privateKey);
    this.keyPairs.set(id, key);
    const mac: SavedMac = { id, name: offer.macName, routes: learnRoutes(saved?.routes ?? [], offer.routes), lastRoute: saved?.lastRoute ?? null };
    this.saveMac(mac);
    this.effects.macs.setActiveId(id);
    this.abandon();
    this.adopt(mac, result.route, result.value);
    return { ok: true, mac: { id, name: result.value.hello.mac.name } };
  }

  /** Shows another saved Mac. */
  select(id: string): void {
    if (this.effects.macs.activeId() === id) return;
    this.effects.macs.setActiveId(id);
    this.abandon();
    this.attempt = 0;
    this.connectNow(null);
  }

  /**
   * Forgets a Mac here: its record, this phone's key for it and what was cached from it. `lost` says why when the
   * person did not ask, which the unpaired screen tells them.
   */
  async forget(id: string, lost: LostMac["why"] | null = null): Promise<void> {
    const wasActive = this.effects.macs.activeId() === id;
    const name = this.saved.find((mac) => mac.id === id)?.name ?? "Your Mac";
    this.removeMac(id);
    this.keyPairs.delete(id);
    this.effects.forgetCache(id);
    if (wasActive) {
      this.effects.macs.setActiveId(this.effects.macs.list()[0]?.id ?? null);
      this.abandon();
      this.attempt = 0;
      if (this.active()) this.connectNow(null);
      else this.enter({ kind: "unpaired", lost: lost && { why: lost, macName: name } });
    }
    await this.effects.keys.remove(id);
  }

  appState(state: "active" | "background"): void {
    if (state === "background") {
      this.backgroundedAt ??= this.effects.clock.now();
      this.backgroundTimer ??= this.effects.clock.setTimeout(() => this.suspend(), BACKGROUND_GRACE_MS);
      return;
    }
    const away = this.backgroundedAt === null ? 0 : this.effects.clock.now() - this.backgroundedAt;
    this.backgroundedAt = null;
    this.effects.clock.clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
    const phase = this.phase;
    if (phase.kind === "connected" && away < STALE_AFTER_MS) this.ping(phase.session);
    else if (phase.kind === "connected" || phase.kind === "suspended") this.retryNow(null);
    else if (phase.kind === "waiting") this.retryNow(phase.why);
  }

  setNetwork(network: NetworkKind): void {
    if (network === this.network) return;
    this.network = network;
    const phase = this.phase;
    if (phase.kind === "waiting") this.retryNow(phase.why === "offline" ? null : phase.why);
    else if (phase.kind === "connected" && phase.route.kind === "lan" && network === "cellular") this.retryNow(null);
    else if (phase.kind === "connected" && phase.route.kind === "tailnet" && network === "wifi") void this.moveToLan(phase);
  }

  private saveMac(mac: SavedMac): void {
    this.effects.macs.save(mac);
    this.saved = this.effects.macs.list();
    for (const listener of this.listeners) listener();
  }

  private removeMac(id: string): void {
    this.effects.macs.remove(id);
    this.saved = this.effects.macs.list();
    for (const listener of this.listeners) listener();
  }

  private active(): SavedMac | null {
    const id = this.effects.macs.activeId();
    return this.effects.macs.list().find((mac) => mac.id === id) ?? null;
  }

  private async keyPair(macId: string): Promise<KeyPair | null> {
    const known = this.keyPairs.get(macId);
    if (known) return known;
    const privateKey = await this.effects.keys.read(macId);
    if (!privateKey) return null;
    const pair = this.effects.crypto.keyPairFromPrivate(privateKey);
    this.keyPairs.set(macId, pair);
    return pair;
  }

  private dial(route: Route, macKey: Uint8Array, device: KeyPair, pair?: PhoneHello["pair"]): Attempt<Linked> {
    const socket = this.effects.openSocket(route);
    const hello = { device: { name: this.effects.deviceName.slice(0, 80) || "iPhone" }, ...(pair ? { pair } : {}) };
    const answer = socket.opened.then(
      (opened) => connectLink({ socket: opened, crypto: this.effects.crypto, device, macKey, hello, timeoutMs: ROUTE_TIMEOUT_MS }),
      () => ({ ok: false, refused: null, error: "no socket" }) as const,
    );
    return {
      answer: answer.then((result) => (result.ok ? { ok: true, value: { session: result.session, hello: result.hello } } : { ok: false, refused: result.refused })),
      cancel: () => socket.close(),
    };
  }

  /** Races the active Mac's routes for this network. */
  private connectNow(why: DownReason | null): void {
    this.effects.clock.clearTimeout(this.retryTimer);
    const mac = this.active();
    if (!mac) return this.enter({ kind: "unpaired", lost: null });
    const routes = routesFor(mac, this.network);
    if (routes.length === 0) return this.enter({ kind: "waiting", why: "offline", retryAt: null });
    const epoch = ++this.epoch;
    this.enter({ kind: "connecting", why });
    void this.keyPair(mac.id).then(async (key) => {
      if (epoch !== this.epoch) return;
      // The Keychain lost this phone's key: only pairing again can help.
      if (!key) return this.forget(mac.id, "key-lost");
      const result = await raceRoutes(routes, (route) => this.dial(route, fromBase64Url(mac.id), key), this.effects.clock, closeLinked);
      if (epoch !== this.epoch) return result.ok ? closeLinked(result.value) : undefined;
      this.settleRace(mac, result, why);
    });
  }

  private settleRace(mac: SavedMac, result: RaceResult<Linked>, why: DownReason | null): void {
    if (result.ok) return this.adopt(mac, result.route, result.value);
    switch (result.refused) {
      case "unpaired":
        return void this.forget(mac.id, "removed");
      case "incompatible":
        return this.enter({ kind: "incompatible" });
      case "busy":
        return this.retryLater("busy");
      default:
        return this.retryLater(why ?? "unreachable");
    }
  }

  /** Makes `linked` the session for `mac`, learning the routes its hello lists. */
  private adopt(mac: SavedMac, route: Route, { session, hello }: Linked): void {
    const learned: SavedMac = { ...mac, name: hello.mac.name, routes: learnRoutes(mac.routes, hello.routes), lastRoute: route };
    this.saveMac(learned);
    this.stopPings();
    this.attempt = 0;
    this.closing = null;
    this.enter({ kind: "connected", route, session, serial: ++this.sessions });
    this.connection.attach(session);
    session.onBytes((stream, chunk, end) => this.connection.receiveBytes(stream, chunk, end));
    session.onMessage((message) => this.receive(session, message));
    session.onClose((code, reason) => this.dropped(session, code, reason));
    this.schedulePing(session);
    if (session.closed) this.dropped(session, LinkCloseCode.normal, "");
  }

  private receive(session: PhoneSession, message: MacMessage): void {
    if (message.t !== "pong" && message.t !== "closing") return this.connection.receive(session, message);
    if (!this.isCurrent(session)) return;
    if (message.t === "closing") this.closing = message.reason;
    else {
      this.effects.clock.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** The current session ended: the Mac's reason, if it gave one, decides what comes next. */
  private dropped(session: PhoneSession, code: number, reason: string): void {
    if (!this.isCurrent(session)) return;
    const closing = this.closing ?? (code === LinkCloseCode.closing && closingReasons.has(reason) ? (reason as ClosingReason) : null);
    this.closing = null;
    const mac = this.active();
    if (closing === "removed" && mac) return void this.forget(mac.id, "removed");
    if (closing === "disabled") return this.retryLater("disabled");
    if (closing === "update" || closing === "shutdown") return this.retryLater("restarting");
    this.retryLater("unreachable");
  }

  private retryLater(why: DownReason): void {
    const delay = backoffMs(this.attempt++, this.effects.random);
    this.enter({ kind: "waiting", why, retryAt: this.effects.clock.now() + delay });
    this.retryTimer = this.effects.clock.setTimeout(() => this.connectNow(why), delay);
  }

  private retryNow(why: DownReason | null): void {
    this.abandon();
    this.attempt = 0;
    this.connectNow(why);
  }

  /** On Wi-Fi again while the tailnet carries the session: moves to a LAN route if one answers. */
  private async moveToLan(from: Live): Promise<void> {
    const mac = this.active();
    const key = mac && (await this.keyPair(mac.id));
    const routes = mac ? routesFor(mac, "wifi").filter((route) => route.kind === "lan") : [];
    if (!mac || !key || routes.length === 0) return;
    const epoch = this.epoch;
    const result = await raceRoutes(routes, (route) => this.dial(route, fromBase64Url(mac.id), key), this.effects.clock, closeLinked);
    if (!result.ok) return;
    if (epoch !== this.epoch || this.phase !== from) return closeLinked(result.value);
    this.adopt(mac, result.route, result.value);
    const timer = this.effects.clock.setTimeout(() => from.session.close(LinkCloseCode.normal), DRAIN_MS);
    void this.connection.drained(from.session).then(() => {
      this.effects.clock.clearTimeout(timer);
      from.session.close(LinkCloseCode.normal);
    });
  }

  private suspend(): void {
    this.backgroundTimer = null;
    if (this.phase.kind === "unpaired" || this.phase.kind === "incompatible") return;
    this.abandon();
    this.enter({ kind: "suspended" });
  }

  /** Stops whatever is in flight and closes the session, without treating the close as a drop. */
  private abandon(): void {
    this.epoch++;
    this.effects.clock.clearTimeout(this.retryTimer);
    this.stopPings();
    const phase = this.phase;
    if (phase.kind !== "connected") return;
    this.enter({ kind: "connecting", why: null });
    phase.session.close(LinkCloseCode.normal);
  }

  private schedulePing(session: PhoneSession): void {
    this.pingTimer = this.effects.clock.setTimeout(() => this.ping(session), PING_EVERY_MS);
  }

  /** A ping the Mac must answer in time, or the session is treated as gone. */
  private ping(session: PhoneSession): void {
    if (!this.isCurrent(session)) return;
    this.stopPings();
    session.send({ t: "ping", id: ++this.pingId });
    this.pongTimer = this.effects.clock.setTimeout(() => session.close(LinkCloseCode.timeout, "no answer"), PONG_WITHIN_MS);
    this.schedulePing(session);
  }

  private stopPings(): void {
    this.effects.clock.clearTimeout(this.pingTimer);
    this.effects.clock.clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private isCurrent(session: PhoneSession): boolean {
    return this.phase.kind === "connected" && this.phase.session === session;
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    const mac = this.active();
    this.state = toState(phase, mac && { id: mac.id, name: mac.name });
    for (const listener of this.listeners) listener();
  }
}

function toState(phase: Phase, mac: MacName | null): LinkState {
  if (phase.kind === "unpaired") return { kind: "unpaired", lost: phase.lost };
  if (!mac) return { kind: "unpaired", lost: null };
  if (phase.kind === "connected") return { kind: "connected", mac, route: phase.route, serial: phase.serial };
  return { ...phase, mac };
}

function pairFailure(refused: Refusal | null): PairResult {
  if (!refused) return { ok: false, message: "Could not reach your Mac. Check that this phone is on its network or tailnet.", spent: false };
  // Only a busy Mac may take the same code a moment later; another version will not until one of them updates.
  return { ok: false, message: refusalWords[refused], spent: refused !== "busy" };
}

function closeLinked({ session }: Linked): void {
  session.close(LinkCloseCode.normal);
}
