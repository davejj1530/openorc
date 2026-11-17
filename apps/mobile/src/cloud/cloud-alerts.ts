import { fromBase64Url, toBase64Url, type LinkCrypto } from "@openorc/link";
import type { PushRegistration, PushSenderState } from "@openorc/protocol";

/** What the phone's own cloud registers this phone with: its alerts, under its key, and the server's key in answer. */
export interface DeviceRegistry {
  /** Registers under `id`, the phone's public key, which the server takes as the key it seals for. */
  registerDevice(id: string, registration: PushRegistration): Promise<{ sender: PushSenderState; publicKey: string }>;
  removeDevice(id: string): Promise<void>;
}

/** This phone's key for an account server: its pair, and the server's key once the server has said it. */
export interface CloudDeviceKey {
  server: string;
  privateKey: string;
  serverKey: string | null;
  registered: boolean;
}

/** Where the phone keeps its key for the account server, and files it under the server's key for the extension. */
export interface CloudKeyStore {
  load(): Promise<CloudDeviceKey | null>;
  save(key: CloudDeviceKey | null): Promise<void>;
  /** Files the private key where the notification extension finds a sender's: `device-key.<sender key>`. */
  file(senderKey: string, privateKey: Uint8Array): Promise<void>;
  unfile(senderKey: string): Promise<void>;
}

export interface CloudAlertsDeps {
  crypto: Pick<LinkCrypto, "generateKeyPair" | "keyPairFromPrivate">;
  keys: CloudKeyStore;
  /** The phone's own cloud while it holds a session: its server, and the registry its session reaches. */
  held(): { server: string; registry: DeviceRegistry } | null;
  /** What the phone wants of alerts now, as it tells its Macs; null while it wants none or iOS gives it none. */
  registration(): PushRegistration | null;
  warn(message: string): void;
}

/**
 * Alerts about the person's OpenOrc Cloud threads, which the server sends while the phone holds a session of its own:
 * the phone registers its token under a key of its own for that server, and files that key under the server's key so
 * the notification extension opens what the server sealed, as it opens what a Mac sealed. A server with no Apple key
 * yet says so and sends nothing; the phone shows nothing of it. The server forgets the phone with its session; the
 * phone then forgets its key.
 */
export class CloudAlerts {
  #key: CloudDeviceKey | null = null;
  #loaded = false;
  #sender: PushSenderState | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CloudAlertsDeps) {}

  /** The server's key while the phone takes its alerts: the sender an alert from it names. */
  senderKey(): string | null {
    return this.#key?.registered ? this.#key.serverKey : null;
  }

  /** Whether the server can send to this phone, once it has said: "no-key" until it has Apple's key. */
  senderState(): PushSenderState | null {
    return this.#sender;
  }

  /** Brings the server's word in line with what the phone wants now and the session it holds. One at a time. */
  sync(): Promise<void> {
    const next = this.#queue.then(() => this.#sync()).catch((error: unknown) => this.deps.warn(`Cloud alerts were not registered: ${error instanceof Error ? error.message : String(error)}`));
    this.#queue = next;
    return next;
  }

  async #sync(): Promise<void> {
    if (!this.#loaded) {
      this.#key = await this.deps.keys.load();
      this.#loaded = true;
    }
    const held = this.deps.held();
    // No session, or another server's: the server forgot this phone with the session it had; so does the phone.
    if (!held || (this.#key && this.#key.server !== held.server)) await this.#forget();
    if (!held) return;
    const key = this.#key ?? (await this.#make(held.server));
    const id = toBase64Url(this.deps.crypto.keyPairFromPrivate(fromBase64Url(key.privateKey)).publicKey);
    const registration = this.deps.registration();
    if (!registration) {
      if (key.registered) await held.registry.removeDevice(id);
      await this.#keep({ ...key, registered: false });
      this.#sender = null;
      return;
    }
    const answer = await held.registry.registerDevice(id, registration);
    this.#sender = answer.sender;
    if (key.serverKey !== answer.publicKey) {
      if (key.serverKey) await this.deps.keys.unfile(key.serverKey);
      await this.deps.keys.file(answer.publicKey, fromBase64Url(key.privateKey));
    }
    await this.#keep({ ...key, serverKey: answer.publicKey, registered: true });
  }

  async #make(server: string): Promise<CloudDeviceKey> {
    const pair = this.deps.crypto.generateKeyPair();
    const key = { server, privateKey: toBase64Url(pair.privateKey), serverKey: null, registered: false };
    await this.#keep(key);
    return key;
  }

  async #keep(key: CloudDeviceKey): Promise<void> {
    this.#key = key;
    await this.deps.keys.save(key);
  }

  async #forget(): Promise<void> {
    const key = this.#key;
    if (!key) return;
    if (key.serverKey) await this.deps.keys.unfile(key.serverKey);
    this.#key = null;
    this.#sender = null;
    await this.deps.keys.save(null);
  }
}
