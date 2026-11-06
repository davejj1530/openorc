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
import type { PhoneDoors } from "./door";
import { LinkConnection, type PhoneLine } from "./link-connection";
import { raceRoutes, ROUTE_TIMEOUT_MS, type Attempt, type Clock, type RaceResult } from "./route-race";
import { learnRoutes, routesFor, type DeviceKeys, type MacStore, type NetworkKind, type SavedMac } from "./saved-macs";
import { SocketFailed } from "./socket-failure";

/**
 * Why the phone is not connected to the Mac it shows, as far as it knows. `unreachable`: no route answered, or the
 * session dropped. `silent`: the Mac has not answered for a minute, so it is likely asleep or on another network.
 * `tailnet`: on cellular, where only the Mac's tailnet addresses could answer, none did, though the internet answers.
 * `no-route`: this network has no way to the Mac (cellular, and it has no tailnet or public address). `offline`: nothing
 * gets out, with no network at all or one that reaches nowhere. The rest come from a host's door: `waking` while it
 * wakes the host, `wake-refused` when it does not take this phone's knock, `needs-mac` when only the host's Mac can help,
 * and `wake-failed` when the host did not start.
 */
export type DownReason = "unreachable" | "silent" | "tailnet" | "no-route" | "offline" | "restarting" | "disabled" | "busy" | "waking" | "wake-refused" | "needs-mac" | "wake-failed";

/** The reasons the Mac itself, or its door, gave, which still stand while it does not answer. */
const macReasons: ReadonlySet<DownReason> = new Set(["restarting", "disabled", "busy", "wake-refused", "needs-mac"]);

export interface MacName {
  id: string;
  name: string;
  /** A cloud brain or a Mac, as saved; hosts saved before read as Macs. */
  kind?: "mac" | "brain";
}

/** Why the phone has no Mac any more: the Mac removed it, or the Keychain lost the key it pairs with. */
export type LostMac = { why: "removed" | "key-lost"; macName: string };

/** How the phone reaches the Mac it shows: over the network, or inside the app for the demo Mac. */
export type LinkRoute = Route | { kind: "demo" };

/**
 * A Mac inside the app, for a look around before pairing. Nothing it does touches a network, a saved Mac or a key,
 * and nothing done over a line outlives it.
 */
export interface DemoMac {
  readonly mac: MacName;
  /** A line to a fresh demo Mac. */
  open(): PhoneLine;
}

/** The phone's connection to the Mac it shows: one state at a time, so a screen never reconciles flags. */
export type LinkState =
  /** `lost` says why the last Mac went, when it was not the person's own Forget. */
  | { kind: "unpaired"; lost: LostMac | null }
  /** `why` is what ended the last session or attempt, kept so a retry does not flicker the screen. */
  | { kind: "connecting"; mac: MacName; why: DownReason | null }
  /** `serial` counts the sessions: each new one, on any route, has a new serial, so a call that failed can tell. */
  | { kind: "connected"; mac: MacName; route: LinkRoute; serial: number }
  /** Trying again at `retryAt`, or once there is a network when it is null. */
  | { kind: "waiting"; mac: MacName; why: DownReason; retryAt: number | null }
  /** Closed after a while in the background; reconnects when the app comes back. */
  | { kind: "suspended"; mac: MacName }
  | { kind: "incompatible"; mac: MacName };

/** The demo Mac is the one shown. */
export const showsDemo = (state: LinkState): boolean => state.kind === "connected" && state.route.kind === "demo";

/** The state with what each one holds: the session while connected. The Mac's name comes from the store, or the demo. */
type Phase =
  | { kind: "unpaired"; lost: LostMac | null }
  | Demo
  | { kind: "connecting"; why: DownReason | null }
  | Live
  | { kind: "waiting"; why: DownReason; retryAt: number | null }
  | { kind: "suspended" }
  | { kind: "incompatible" };
type Live = { kind: "connected"; route: Route; session: PhoneSession; serial: number };
type Demo = { kind: "demo"; mac: MacName; line: PhoneLine; serial: number };

/** A socket being opened. `close` also abandons one that has not opened yet. */
export interface OpeningSocket {
  opened: Promise<LinkSocket>;
  close(): void;
}

export interface ConnectionEffects {
  /** `hostKey` names the host's path behind a proxy; a direct route does not use it. */
  openSocket(route: Route, hostKey: Uint8Array): OpeningSocket;
  crypto: LinkCrypto;
  clock: Clock;
  random(): number;
  macs: MacStore;
  keys: DeviceKeys;
  deviceName: string;
  /** Deletes what the app cached for a Mac it forgets. */
  forgetCache(macId: string): void;
  /** Whether anything on the internet answers, for a race lost off Wi-Fi. Aborted once the phone stops waiting. */
  reachesInternet(signal: AbortSignal): Promise<boolean>;
  /** Hosts' doors: each session's key, and the knock that wakes a host asleep behind its proxy. */
  doors: PhoneDoors;
  /** A host named the cloud brains it removed. Only the shown host's link forgets hosts, so every link hands them there. */
  brainsRemoved(macId: string, removed: readonly string[]): void;
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
/** A Mac the phone has not heard from for this long is not reachable rather than reconnecting. */
const SILENT_AFTER_MS = 60_000;
/** How long the phone waits to learn whether the internet answers before it takes that as no. */
const INTERNET_WITHIN_MS = 3_000;
/**
 * Back after this long, the session is not trusted: iOS suspends the app's timers and sockets a few seconds into the
 * background, so the grace timer may never have fired and the socket may be dead while the phase still says connected.
 */
const STALE_AFTER_MS = 5_000;
/** How long a session replaced by a better route keeps answering calls already sent over it. */
const DRAIN_MS = 5_000;
/** A host's door is knocked on at most this often. */
const KNOCK_EVERY_MS = 60_000;
/** Agent37 holds a call to a sleeping brain until it restores, and asks callers to wait at least three minutes. */
const BRAIN_WAKE_MS = 180_000;
const REFUSED = Number.POSITIVE_INFINITY;

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
  /**
   * Since when the phone has asked the shown Mac on this network without an answer: from a session's end or the first
   * failed attempt. Only time spent asking counts, so it starts over whenever the phone could not have asked.
   */
  private unheardSince: number | null = null;
  private silentTimer: unknown = null;
  /** When the phone last knocked on each host's door; never again, for one that refused it, until the person is back. */
  private readonly knocked = new Map<string, number>();
  private knocking: AbortController | null = null;
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

  /** Shows the demo Mac, while no Mac is paired. */
  showDemo(demo: DemoMac): void {
    if (this.phase.kind !== "unpaired" || this.saved.length > 0) return;
    const line = demo.open();
    const phase: Demo = { kind: "demo", mac: demo.mac, line, serial: ++this.sessions };
    this.enter(phase);
    this.connection.attach(line);
    line.onBytes((stream, chunk, end) => this.connection.receiveBytes(stream, chunk, end));
    line.onMessage((message) => {
      if (message.t !== "pong" && message.t !== "closing") this.connection.receive(line, message);
    });
    line.onClose(() => {
      if (this.phase === phase) this.enter({ kind: "unpaired", lost: null });
    });
  }

  /** Back to no Mac, leaving nothing of the demo behind. */
  endDemo(): void {
    const phase = this.phase;
    if (phase.kind !== "demo") return;
    this.enter({ kind: "unpaired", lost: null });
    phase.line.close(LinkCloseCode.normal, "");
  }

  /** Shows another saved Mac. */
  select(id: string): void {
    if (this.effects.macs.activeId() === id) return;
    this.effects.macs.setActiveId(id);
    // Another link may have paired with this host anew meanwhile; the Keychain holds the key it uses now.
    this.keyPairs.delete(id);
    this.abandon();
    this.clearSilence();
    this.forgiveRefusal(id);
    this.attempt = 0;
    this.connectNow(null);
  }

  /**
   * Shows no host, forgetting none: for a link that follows another's group, when the group has no partner. Its keys are
   * read again next time, since the other link may have forgotten the host and paired with it anew meanwhile.
   */
  release(): void {
    this.keyPairs.clear();
    if (this.effects.macs.activeId() === null && this.phase.kind === "unpaired") return;
    this.effects.macs.setActiveId(null);
    this.abandon();
    this.clearSilence();
    this.attempt = 0;
    this.enter({ kind: "unpaired", lost: null });
  }

  /**
   * Forgets a Mac here: its record, this phone's key for it and what was cached from it. `lost` says why when the
   * person did not ask, which the unpaired screen tells them.
   */
  async forget(id: string, lost: LostMac["why"] | null = null): Promise<void> {
    if (this.phase.kind === "demo" && this.phase.mac.id === id) return this.endDemo();
    const wasActive = this.effects.macs.activeId() === id;
    const name = this.saved.find((mac) => mac.id === id)?.name ?? "Your Mac";
    this.removeMac(id);
    this.keyPairs.delete(id);
    this.knocked.delete(id);
    this.effects.forgetCache(id);
    if (wasActive) {
      this.effects.macs.setActiveId(this.effects.macs.list()[0]?.id ?? null);
      this.abandon();
      this.clearSilence();
      this.attempt = 0;
      if (this.active()) this.connectNow(null);
      else this.enter({ kind: "unpaired", lost: lost && { why: lost, macName: name } });
    }
    await Promise.all([this.effects.keys.remove(id), this.effects.doors.forget(id)]);
  }

  appState(state: "active" | "background"): void {
    // The demo needs no network, so iOS suspending sockets in the background leaves it be.
    if (this.phase.kind === "demo") return;
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
    this.clearSilence();
    const phase = this.phase;
    if (phase.kind === "waiting") this.retryNow(macReasons.has(phase.why) ? phase.why : null);
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
    const socket = this.effects.openSocket(route, macKey);
    const hello = { device: { name: this.effects.deviceName.slice(0, 80) || "iPhone" }, ...(pair ? { pair } : {}) };
    const answer = socket.opened.then(
      (opened) => connectLink({ socket: opened, crypto: this.effects.crypto, device, macKey, hello, timeoutMs: ROUTE_TIMEOUT_MS }),
      (error: unknown) => ({ ok: false, refused: null, error: "no socket", answered: error instanceof SocketFailed && error.status !== null }) as const,
    );
    return {
      answer: answer.then((result) =>
        result.ok
          ? { ok: true, value: { session: result.session, hello: result.hello } }
          : { ok: false, refused: result.refused, ...("answered" in result && result.answered ? { answered: true } : {}) },
      ),
      cancel: () => socket.close(),
    };
  }

  /** Races the active Mac's routes for this network. */
  private connectNow(why: DownReason | null): void {
    this.effects.clock.clearTimeout(this.retryTimer);
    const mac = this.active();
    if (!mac) return this.enter({ kind: "unpaired", lost: null });
    const routes = routesFor(mac, this.network);
    if (routes.length === 0) return this.enter({ kind: "waiting", why: this.network === "none" ? "offline" : "no-route", retryAt: null });
    const epoch = ++this.epoch;
    this.enter({ kind: "connecting", why });
    void this.keyPair(mac.id).then(async (key) => {
      if (epoch !== this.epoch) return;
      // The Keychain lost this phone's key: only pairing again can help.
      if (!key) return this.forget(mac.id, "key-lost");
      const result = await raceRoutes(routes, (route) => this.dial(route, fromBase64Url(mac.id), key), this.effects.clock, closeLinked);
      if (epoch !== this.epoch) return result.ok ? closeLinked(result.value) : undefined;
      // Off Wi-Fi every route runs over the internet, so with none nothing could have answered, Tailscale included.
      const online = result.ok || result.refused !== null || this.network === "wifi" || (await this.online());
      if (epoch !== this.epoch) return;
      this.settleRace(mac, result, why, online, routes);
    });
  }

  /** Whether the internet answers, or false once the phone has waited `INTERNET_WITHIN_MS`. */
  private online(): Promise<boolean> {
    const abort = new AbortController();
    return new Promise((resolve) => {
      const timer = this.effects.clock.setTimeout(() => {
        abort.abort();
        resolve(false);
      }, INTERNET_WITHIN_MS);
      void this.effects
        .reachesInternet(abort.signal)
        .catch(() => false)
        .then((online) => {
          this.effects.clock.clearTimeout(timer);
          resolve(online);
        });
    });
  }

  private settleRace(mac: SavedMac, result: RaceResult<Linked>, why: DownReason | null, online: boolean, tried: readonly Route[]): void {
    if (result.ok) return this.adopt(mac, result.route, result.value);
    switch (result.refused) {
      case "unpaired":
        return void this.forget(mac.id, "removed");
      case "incompatible":
        return this.enter({ kind: "incompatible" });
      case "busy":
        return this.retryLater("busy");
      default:
        if (online && this.mayKnock(mac.id)) return void this.knock(mac, why, tried, result.answered === true);
        return this.retryLater(this.unanswered(why, online, tried));
    }
  }

  private mayKnock(macId: string): boolean {
    const last = this.knocked.get(macId);
    return last === undefined || this.effects.clock.now() - last >= KNOCK_EVERY_MS;
  }

  /** The person came back to the host, or it answered: a door that refused this phone is asked again. */
  private forgiveRefusal(macId: string | null): void {
    if (macId && this.knocked.get(macId) === REFUSED) this.knocked.delete(macId);
  }

  /**
   * Nothing answered and the internet does: a host asleep behind its proxy fails just so, and its door can wake it.
   * Once the door says the host is ready, the phone races again at once. The door finishes a wake the phone left.
   */
  private async knock(mac: SavedMac, why: DownReason | null, tried: readonly Route[], answered: boolean): Promise<void> {
    const epoch = this.epoch;
    const hasDoor = await this.effects.doors.has(mac.id);
    if (epoch !== this.epoch) return;
    // A cloud brain with no door (Agent37) wakes for any request; its address answering with no brain behind it means
    // the brain is not running, and only its Mac can start it again.
    if (!hasDoor && mac.kind === "brain" && !answered) return this.wakeByCalling(mac, why, tried);
    if (!hasDoor) return this.retryLater(answered && mac.kind === "brain" ? "needs-mac" : this.unanswered(why, true, tried));
    this.knocked.set(mac.id, this.effects.clock.now());
    this.enter({ kind: "connecting", why: "waking" });
    const abort = new AbortController();
    this.knocking = abort;
    const outcome = await this.effects.doors.knock(mac.id, abort.signal);
    if (this.knocking === abort) this.knocking = null;
    if (epoch !== this.epoch) return;
    switch (outcome.kind) {
      case "ready": {
        const saved = this.active() ?? mac;
        this.saveMac({ ...saved, routes: learnRoutes(saved.routes, [outcome.route]) });
        return this.connectNow("waking");
      }
      case "refused":
        // Nothing changes that by itself; only pairing again does.
        this.knocked.set(mac.id, REFUSED);
        return this.retryLater("wake-refused");
      case "needs-mac":
        return this.retryLater("needs-mac");
      case "failed":
        return this.retryLater("wake-failed");
      case "unanswered":
        return this.retryLater(this.unanswered(why, true, tried));
    }
  }

  /**
   * A cloud brain with no door (Agent37) wakes for a call to its address: its service holds the call while the brain
   * restores, longer than a route's few seconds. One race waits for that, saying Waking, and the next waits a minute
   * after it ended. Leaving the host calls it off.
   */
  private async wakeByCalling(mac: SavedMac, why: DownReason | null, tried: readonly Route[]): Promise<void> {
    const epoch = this.epoch;
    const key = await this.keyPair(mac.id);
    if (epoch !== this.epoch) return;
    if (!key) return this.forget(mac.id, "key-lost");
    this.knocked.set(mac.id, this.effects.clock.now());
    this.enter({ kind: "connecting", why: "waking" });
    const abort = new AbortController();
    this.knocking = abort;
    const result = await raceRoutes(tried, (route) => this.dial(route, fromBase64Url(mac.id), key), this.effects.clock, closeLinked, {
      timeoutMs: BRAIN_WAKE_MS,
      signal: abort.signal,
    });
    if (this.knocking === abort) this.knocking = null;
    if (epoch !== this.epoch) return result.ok ? closeLinked(result.value) : undefined;
    this.knocked.set(mac.id, this.effects.clock.now());
    if (!result.ok && !result.refused) return this.retryLater(result.answered ? "needs-mac" : this.unanswered(why, true, tried));
    this.settleRace(mac, result, why, true, tried);
  }

  /**
   * Why no route answered: nothing gets out, or a reason the Mac gave still stands; on cellular with only tailnet
   * routes to try, Tailscale is the way in; otherwise a minute without hearing the Mac makes it not reachable rather
   * than reconnecting. A host asleep behind its proxy fails like a Mac that is away.
   */
  private unanswered(why: DownReason | null, online: boolean, tried: readonly Route[]): DownReason {
    if (!online) return "offline";
    if (why && macReasons.has(why)) return why;
    if (this.network === "cellular" && tried.every((route) => route.kind === "tailnet")) return "tailnet";
    const since = this.unheardSince;
    return since !== null && this.effects.clock.now() - since >= SILENT_AFTER_MS ? "silent" : "unreachable";
  }

  /** The phone heard the Mac, shows another one, or could not have asked it: the next silence starts its own minute. */
  private clearSilence(): void {
    this.unheardSince = null;
    this.effects.clock.clearTimeout(this.silentTimer);
    this.silentTimer = null;
  }

  /** Starts the minute after which a Mac that still does not answer reads as not reachable, at that very moment. */
  private startSilence(): void {
    if (this.unheardSince !== null) return;
    this.unheardSince = this.effects.clock.now();
    this.silentTimer = this.effects.clock.setTimeout(() => {
      this.silentTimer = null;
      const phase = this.phase;
      if ((phase.kind === "waiting" || phase.kind === "connecting") && phase.why === "unreachable") this.enter({ ...phase, why: "silent" });
    }, SILENT_AFTER_MS);
  }

  /** Makes `linked` the session for `mac`, learning the routes its hello lists. */
  private adopt(mac: SavedMac, route: Route, { session, hello }: Linked): void {
    const routes = learnRoutes(mac.routes, hello.routes);
    const learned: SavedMac = { ...mac, name: hello.mac.name, routes, lastRoute: route };
    this.saveMac(learned);
    this.stopPings();
    this.clearSilence();
    this.attempt = 0;
    this.closing = null;
    this.enter({ kind: "connected", route, session, serial: ++this.sessions });
    this.connection.attach(session);
    session.onBytes((stream, chunk, end) => this.connection.receiveBytes(stream, chunk, end));
    session.onMessage((message) => this.receive(session, message));
    session.onClose((code, reason) => this.dropped(session, code, reason));
    this.schedulePing(session);
    if (session.closed) return this.dropped(session, LinkCloseCode.normal, "");
    this.forgiveRefusal(mac.id);
    void this.learnKind(mac.id, session);
    void this.learnDoor(mac.id);
    void this.learnRemoved(mac.id);
  }

  /** Asks the host what it is on every session. One from before the question answers with an error, as a Mac would. */
  private async learnKind(macId: string, session: PhoneSession): Promise<void> {
    let kind: "mac" | "brain";
    try {
      kind = (await this.connection.device("host.kind", {})) === "brain" ? "brain" : "mac";
    } catch {
      // A session that dropped before the answer says nothing about the host.
      if (!this.isCurrent(session)) return;
      kind = "mac";
    }
    const saved = this.effects.macs.list().find((mac) => mac.id === macId);
    if (saved && saved.kind !== kind) this.saveMac({ ...saved, kind });
  }

  /** Hears which cloud brains the host removed, on every session. An older host, or a dropped session, says none. */
  private async learnRemoved(macId: string): Promise<void> {
    let removed: string[];
    try {
      removed = await this.connection.device("brains.removed", {});
    } catch {
      return;
    }
    if (removed.length) this.effects.brainsRemoved(macId, removed);
  }

  /** Renews this phone's key to the host's door on every session. An older host, or a dropped session, leaves what is saved. */
  private async learnDoor(macId: string): Promise<void> {
    try {
      await this.effects.doors.learn(macId, await this.connection.device("door.key", {}));
    } catch {
      // Kept as it is.
    }
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
    if (why === "offline") this.clearSilence();
    else this.startSilence();
    const delay = backoffMs(this.attempt++, this.effects.random);
    this.enter({ kind: "waiting", why, retryAt: this.effects.clock.now() + delay });
    // The reason may have moved on while waiting (a minute of silence), so the attempt keeps the current one.
    this.retryTimer = this.effects.clock.setTimeout(() => this.connectNow(this.phase.kind === "waiting" ? this.phase.why : why), delay);
  }

  private retryNow(why: DownReason | null): void {
    this.abandon();
    this.forgiveRefusal(this.effects.macs.activeId());
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
    this.clearSilence();
    this.enter({ kind: "suspended" });
  }

  /** Stops whatever is in flight and closes the session or the demo's line, without treating the close as a drop. */
  private abandon(): void {
    this.epoch++;
    this.effects.clock.clearTimeout(this.retryTimer);
    this.knocking?.abort();
    this.knocking = null;
    this.stopPings();
    const phase = this.phase;
    if (phase.kind !== "connected" && phase.kind !== "demo") return;
    this.enter({ kind: "connecting", why: null });
    if (phase.kind === "demo") phase.line.close(LinkCloseCode.normal, "");
    else phase.session.close(LinkCloseCode.normal);
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
    this.state = toState(phase, mac && { id: mac.id, name: mac.name, kind: mac.kind });
    for (const listener of this.listeners) listener();
  }
}

function toState(phase: Phase, mac: MacName | null): LinkState {
  if (phase.kind === "unpaired") return { kind: "unpaired", lost: phase.lost };
  if (phase.kind === "demo") return { kind: "connected", mac: phase.mac, route: { kind: "demo" }, serial: phase.serial };
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
