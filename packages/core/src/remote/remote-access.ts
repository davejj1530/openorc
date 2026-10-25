import path from "node:path";
import { remoteDevices, remotePushTargets, settings, type Db, type LedgerWriter, type RemoteDeviceRecord } from "@openorc/db";
import { acceptLink, encodePairingUrl, fromBase64Url, LinkCloseCode, toBase64Url, type Admission, type ClosingReason, type KeyPair, type LinkSocket, type PhoneHello } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import {
  PUSH_SENDER_TAG,
  type CorePush,
  type DeviceMethod,
  type DeviceParams,
  type DeviceRpcResults,
  type PairingOfferView,
  type PushEnvironment,
  type PushSenderState,
  type RemoteListener,
  type RemotePushStatus,
  type RemoteRpcResults,
  type RemoteStatus,
  type Route,
} from "@openorc/protocol";
import type { ProtectedSecretStore } from "../services/extraction-credentials.js";
import type { Broadcast, Logger } from "../transport.js";
import { readRemoteAsset } from "./assets.js";
import { listen, type Listener } from "./listener.js";
import { PairingOffers } from "./offers.js";
import { remotePush } from "./policy.js";
import { PushKeys } from "./push/keys.js";
import { PushSender } from "./push/sender.js";
import { currentRoutes, machineProbe, type MachineProbe } from "./routes.js";
import { RemoteSession, type Answer } from "./session.js";
import { RemoteFrameShaper } from "./shaper.js";

const SETTING = "remote.access";
const DEFAULT_PORT = 47_820;
const MAX_SESSIONS = 16;
/** The desktop's status, and phones, which register again to hear whether this Mac can send now. */
const SENDER_CHANGED = ["remote", PUSH_SENDER_TAG];

/** Where phone access listens and how the Mac describes itself. Tests pass port 0, a fixed machine and a fake APNs. */
export interface RemoteNetwork {
  port: number;
  machine: MachineProbe;
  apns?: Record<PushEnvironment, string>;
}

export interface RemoteAccessOptions {
  db: Db;
  dataDir: string;
  ledger: LedgerWriter;
  /** Keeps the Mac's static key pair. Without it, phone access cannot turn on. */
  secrets: ProtectedSecretStore | undefined;
  log: Logger;
  invalidate(keys: string[]): void;
  network?: RemoteNetwork;
  /** Keeps the Apple push key. Without it, no key can be added. */
  pushSecrets?: ProtectedSecretStore;
  /** Whether someone is using the Mac. Without it, the Mac always reads as away. */
  presence?: () => Promise<boolean>;
}

interface AccessSetting {
  enabled: boolean;
  /** Chosen on first start and kept, so the routes a phone saved stay valid. */
  port: number | null;
}

type State = { state: "off" } | { state: "on"; listener: Listener; keys: KeyPair } | { state: "failed"; reason: string };

function readSetting(db: Db): AccessSetting {
  try {
    const value = JSON.parse(settings.get(db, SETTING) ?? "null") as Partial<AccessSetting> | null;
    if (typeof value?.enabled === "boolean") return { enabled: value.enabled, port: Number.isInteger(value.port) ? (value.port as number) : null };
  } catch {
    // An unreadable setting reads as never configured.
  }
  return { enabled: false, port: null };
}

/**
 * Phone access, composed by OpenOrc like the Slack relay. It listens while the user has it on and the host has
 * attached its request path, admits paired phones and spends pairing offers, and hands each phone the pushes it
 * may hear. Requests from phones go through the host's own fenced `answer`, so an update waits for them too.
 */
export class RemoteAccess {
  private state: State = { state: "off" };
  private answer: Answer | null = null;
  private closing: ClosingReason | null = null;
  private keys: KeyPair | null = null;
  private work: Promise<void> = Promise.resolve();
  private readonly offers = new PairingOffers();
  private readonly sessions = new Set<RemoteSession>();
  private readonly shaper = new RemoteFrameShaper();
  private readonly network: RemoteNetwork;
  /** The routes last found, so admitting a phone never waits on the Tailscale CLI. */
  private knownRoutes: Route[] = [];
  private readonly pushKeys: PushKeys;
  private readonly push: PushSender;

  constructor(private readonly options: RemoteAccessOptions) {
    this.network = options.network ?? { port: DEFAULT_PORT, machine: machineProbe() };
    const { db, log } = options;
    this.pushKeys = new PushKeys({ db, secrets: options.pushSecrets, log, ...(this.network.apns ? { origins: this.network.apns } : {}) });
    const presence = options.presence ?? (async () => false);
    this.push = new PushSender({ db, log, presence, route: () => this.pushKeys.current(), changed: (what) => options.invalidate(what === "sender" ? SENDER_CHANGED : ["remote"]) });
  }

  /** Called once by the host with the request path its windows use. Starts listening if the user left it on. */
  attach(answer: Answer): Promise<void> {
    this.answer ??= answer;
    return this.converge();
  }

  async status(): Promise<RemoteStatus> {
    await this.work;
    const connected = new Set([...this.sessions].filter((session) => session.live).map((session) => session.deviceId));
    return {
      listener: await this.listenerView(),
      devices: remoteDevices.list(this.options.db).map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt, connected: connected.has(id) })),
      pairing: this.offers.open(Date.now()),
      push: this.pushStatus(),
    };
  }

  async configure(enabled: boolean): Promise<RemoteStatus> {
    settings.set(this.options.db, SETTING, JSON.stringify({ ...readSetting(this.options.db), enabled }));
    await this.converge();
    this.options.invalidate(["remote"]);
    return this.status();
  }

  /** A fresh single-use offer; an open one stops working. */
  async beginPairing(): Promise<PairingOfferView> {
    await this.work;
    if (this.state.state !== "on") throw new Error("Turn on phone access first.");
    const { offerId, secret, expiresAt } = this.offers.begin(Date.now());
    const url = encodePairingUrl({ macName: this.network.machine.name(), macKey: this.state.keys.publicKey, offerId, secret, routes: await this.routes(), expiresAt });
    this.options.invalidate(["remote"]);
    return { offerId, url, expiresAt };
  }

  cancelPairing(offerId: string): void {
    if (this.offers.cancel(offerId)) this.options.invalidate(["remote"]);
  }

  /** Forgets the phone and ends its sessions. Removing a phone that is already gone changes nothing. */
  removeDevice(id: string): void {
    remoteDevices.remove(this.options.db, id);
    for (const session of this.sessions) if (session.deviceId === id) session.close("removed");
    this.options.invalidate(["remote"]);
  }

  /** Methods about the calling phone itself, for the device its session was admitted as. */
  async device(deviceId: string, method: DeviceMethod, params: DeviceParams<DeviceMethod>): Promise<DeviceRpcResults[DeviceMethod]> {
    switch (method) {
      case "push.register": {
        const { db } = this.options;
        if (params.registration) remotePushTargets.set(db, deviceId, params.registration, Date.now());
        else remotePushTargets.remove(db, deviceId);
        this.options.invalidate(["remote"]);
        return { sandbox: this.senderState("sandbox"), production: this.senderState("production") };
      }
    }
  }

  /** Every notice the core makes, before the desktop's own switch: phones choose for themselves. Never throws into the core. */
  alert(notice: Extract<CorePush, { type: "notify" }>): void {
    if (this.state.state !== "on") return;
    try {
      const redacted = remotePush(notice);
      if (redacted?.type === "notify") void this.push.send(redacted, this.state.keys);
    } catch (error) {
      this.options.log.warn(`phone access dropped an alert: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The Apple push key, from the file Apple gave the user. Refused unless it is a P-256 key. */
  async setPushKey(keyId: string, pem: string): Promise<RemoteStatus> {
    await this.pushKeys.set(keyId, pem);
    return this.pushKeyChanged();
  }

  async removePushKey(): Promise<RemoteStatus> {
    await this.pushKeys.remove();
    return this.pushKeyChanged();
  }

  /** The desktop's "Send a test", to every phone with notifications on. */
  async testPush(): Promise<RemoteRpcResults["remote.push.test"]> {
    await this.work;
    if (this.state.state !== "on") throw new Error("Turn on phone access first.");
    return this.push.test(this.state.keys, this.network.machine.name());
  }

  /** The core's push tap: every broadcast, shaped once, to every phone that may hear it. Never throws into the core. */
  publish(push: Broadcast): void {
    if (this.sessions.size === 0) return;
    try {
      this.deliver(push);
    } catch (error) {
      // Logs are not delivered to phones, so this cannot loop back here.
      this.options.log.warn(`phone access dropped a push: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private deliver(push: Broadcast): void {
    const remote = remotePush(push);
    if (!remote) return;
    if (remote.type !== "frame") {
      for (const session of this.sessions) session.push(remote);
      return;
    }
    const listeners = [...this.sessions].filter((session) => session.wants(remote.frame.runId));
    if (listeners.length === 0) return;
    const shaped = this.shaper.shape(remote.frame);
    for (const session of listeners) session.push({ type: "frame", frame: shaped.frame }, shaped.bytes);
  }

  /** First step of the core's shutdown: phones hear why, then sockets and the listener close. */
  async close(reason: "update" | "shutdown"): Promise<void> {
    this.closing = reason;
    await this.converge();
  }

  private converge(): Promise<void> {
    this.work = this.work.then(() => this.apply()).catch((error: unknown) => this.options.log.error(`phone access: ${error instanceof Error ? error.message : String(error)}`));
    return this.work;
  }

  private async apply(): Promise<void> {
    const wanted = Boolean(this.answer) && !this.closing && readSetting(this.options.db).enabled;
    if (wanted && this.state.state !== "on") await this.start();
    if (!wanted && this.state.state === "on") await this.stop(this.closing ?? "disabled");
    if (!wanted && this.state.state === "failed") this.state = { state: "off" };
  }

  private async start(): Promise<void> {
    try {
      const keys = await this.loadKeys();
      const setting = readSetting(this.options.db);
      const listener = await listen({ port: setting.port ?? this.network.port, handshake: (socket) => this.handshake(socket) });
      if (listener.port !== setting.port) settings.set(this.options.db, SETTING, JSON.stringify({ ...setting, port: listener.port }));
      this.state = { state: "on", listener, keys };
      await this.routes();
    } catch (error) {
      this.state = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    this.options.invalidate(["remote"]);
  }

  private async stop(reason: ClosingReason): Promise<void> {
    if (this.state.state !== "on") return;
    const { listener } = this.state;
    this.state = { state: "off" };
    const offer = this.offers.open(Date.now());
    if (offer) this.offers.cancel(offer.offerId);
    for (const session of this.sessions) session.close(reason);
    this.sessions.clear();
    this.pushKeys.close();
    this.push.close();
    await listener.close();
    this.options.invalidate(["remote"]);
  }

  private async loadKeys(): Promise<KeyPair> {
    if (this.keys) return this.keys;
    const store = this.options.secrets;
    if (!store) throw new Error("Phone access needs protected storage for its key, which is not available.");
    const saved = await store.load();
    if (saved) {
      const privateKey = (JSON.parse(saved) as { privateKey?: unknown }).privateKey;
      if (typeof privateKey !== "string") throw new Error("The saved phone access key cannot be read.");
      this.keys = nodeCrypto.keyPairFromPrivate(fromBase64Url(privateKey));
    } else {
      const keys = nodeCrypto.generateKeyPair();
      await store.save(JSON.stringify({ privateKey: toBase64Url(keys.privateKey) }));
      this.keys = keys;
    }
    return this.keys;
  }

  private pushKeyChanged(): Promise<RemoteStatus> {
    this.push.keyChanged();
    this.options.invalidate(SENDER_CHANGED);
    return this.status();
  }

  /** What a phone on this host hears: a refusal on the other host says nothing about its alerts. */
  private senderState(environment: PushEnvironment): PushSenderState {
    if (!this.pushKeys.keyId()) return "no-key";
    return this.push.refuses(environment) ? "refused" : "ready";
  }

  private pushStatus(): RemotePushStatus {
    return { keyId: this.pushKeys.keyId(), phones: remotePushTargets.count(this.options.db), problem: this.push.problem };
  }

  private async listenerView(): Promise<RemoteListener> {
    if (this.state.state !== "on") return this.state.state === "failed" ? { state: "failed", reason: this.state.reason } : { state: "off" };
    return { state: "on", port: this.state.listener.port, routes: await this.routes() };
  }

  private async routes(): Promise<Route[]> {
    if (this.state.state !== "on") return [];
    this.knownRoutes = await currentRoutes(this.network.machine, this.state.listener.port);
    return this.knownRoutes;
  }

  private async handshake(socket: LinkSocket): Promise<void> {
    const keys = this.state.state === "on" ? this.state.keys : null;
    const answer = this.answer;
    if (!keys || !answer) {
      socket.close(LinkCloseCode.closing, this.closing ?? "disabled");
      return;
    }
    const accepted = await acceptLink<RemoteDeviceRecord>({ socket, crypto: nodeCrypto, local: keys, admit: (publicKey, hello) => this.admit(publicKey, hello) });
    if (!accepted) return;
    if (this.state.state !== "on") {
      accepted.session.close(LinkCloseCode.closing, this.closing ?? "disabled");
      return;
    }
    const { dataDir, db, ledger } = this.options;
    const session = new RemoteSession(accepted.value.id, accepted.session, {
      answer,
      guard: { attachmentsDir: path.join(dataDir, "attachments") },
      readAsset: (ref) => readRemoteAsset(ref, { dataDir, db, ledger }),
      device: (deviceId, method, params) => this.device(deviceId, method, params),
    });
    // Removing a phone ends the sessions it finds, and this one may have been admitted just before.
    if (remoteDevices.byKey(db, accepted.session.remoteStatic)?.id !== session.deviceId) {
      session.close("removed");
      return;
    }
    this.sessions.add(session);
    session.onClose(() => {
      if (this.sessions.delete(session)) this.options.invalidate(["remote"]);
    });
    // The listener's handshake deadline also covers this wait, so a session that never speaks is closed.
    if (await session.firstRecord) this.options.invalidate(["remote"]);
  }

  /** A known key is admitted; an unknown one only by spending the open offer; anything else hears why not. */
  private admit(publicKey: Uint8Array, hello: PhoneHello): Admission<RemoteDeviceRecord> {
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, reason: "busy" };
    const { db } = this.options;
    const now = Date.now();
    let device = remoteDevices.byKey(db, publicKey);
    if (!device && hello.pair) {
      if (!this.offers.redeem(hello.pair.offerId, secretOf(hello.pair.secret), now)) return { ok: false, reason: "offer-invalid" };
      device = remoteDevices.upsert(db, { publicKey, name: hello.device.name, at: now });
    }
    if (!device) return { ok: false, reason: "unpaired" };
    remoteDevices.touch(db, device.id, now);
    void this.routes();
    return { ok: true, value: device, hello: { mac: { name: this.network.machine.name() }, deviceId: device.id, routes: this.knownRoutes } };
  }
}

function secretOf(text: string): Uint8Array {
  try {
    return fromBase64Url(text);
  } catch {
    return new Uint8Array(0);
  }
}
