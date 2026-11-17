import { createHosted, signInVerifier, type Hosted, type HostedDeps } from "@openorc/hosted";
import type { CloudSessionGrant, CloudSessionOwner } from "@openorc/protocol";

/** What the sign-in page and the account's sessions call this phone. */
export const PHONE_DEVICE = "OpenOrc on iPhone";

/** The phone's session as it keeps it: the server it belongs to, and the package's opaque value (its token in it). */
export interface CloudRecord {
  server: string;
  value: string;
}

/** Where the phone keeps its session, in the Keychain. Never in the app's other storage, never sent to the Mac. */
export interface CloudVault {
  load(): Promise<CloudRecord | null>;
  save(record: CloudRecord | null): Promise<void>;
}

/** The Mac the phone takes its OpenOrc Cloud from: whose it is, and a one-time code for the phone's own session. */
export interface CloudSource {
  owner(): Promise<CloudSessionOwner | null>;
  grant(challenge: string): Promise<CloudSessionGrant>;
}

/** What only the phone has, for the hosted package: its kept answers (`forget` empties them), the network and its socket. */
export interface PhoneCloudDeps {
  vault: CloudVault;
  kept: HostedDeps["kept"] & { forget(): void };
  fetch: HostedDeps["fetch"];
  connect: HostedDeps["connect"];
  push: HostedDeps["push"];
  now(): number;
  log: HostedDeps["log"];
}

/**
 * The phone's own OpenOrc Cloud: a session of its own, which the Mac it pairs with gets it for the person signed in
 * there (`follow`), and drops when that person signs out or another signs in. The phone asks no one to sign in; with
 * no Mac to take a session from, it keeps the one it has.
 */
export class PhoneCloud {
  #hosted: Hosted | null = null;
  #server: string | null = null;
  #record: CloudRecord | null = null;
  #queue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();

  constructor(private readonly deps: PhoneCloudDeps) {}

  /** The phone's own account while it holds a session; null while it holds none. */
  get hosted(): Hosted | null {
    return this.#hosted;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Mounts the session the phone kept, so the cloud is there before any Mac answers. */
  start(): Promise<void> {
    return this.#serial(async () => {
      const record = await this.deps.vault.load();
      if (record) await this.#mount(record);
    });
  }

  /**
   * Takes its session from `source`, the Mac it shows: nothing to do while the session it holds is that Mac's person's
   * on that server; dropped when the Mac has no one signed in; otherwise dropped and taken anew. One at a time.
   */
  follow(source: CloudSource): Promise<void> {
    return this.#serial(async () => {
      const owner = await source.owner();
      const held = this.#held();
      if (!owner) return this.#drop();
      if (held && held.server === owner.server && held.email.toLowerCase() === owner.email.toLowerCase()) return;
      await this.#drop();
      const { verifier, challenge } = await signInVerifier();
      const grant = await source.grant(challenge);
      const hosted = await this.#mount({ server: grant.server, value: "" });
      await hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier });
      this.#told();
    });
  }

  /** Lets the session go with no Mac to take it from: signed out at the server and forgotten. */
  release(): Promise<void> {
    return this.#serial(() => this.#drop());
  }

  close(): void {
    this.#hosted?.close();
    this.#hosted = null;
  }

  /** Whose session the phone holds now, by its server and address; null while it holds none. */
  #held(): CloudSessionOwner | null {
    const status = this.#hosted?.account.status();
    return this.#server && status?.state === "signed-in" ? { server: this.#server, email: status.email } : null;
  }

  async #mount(record: CloudRecord): Promise<Hosted> {
    this.#record = record.value ? record : null;
    this.#server = record.server;
    const hosted = createHosted({
      server: record.server,
      session: {
        load: async () => this.#record?.value ?? null,
        save: async (value) => {
          this.#record = value === null ? null : { server: record.server, value };
          await this.deps.vault.save(this.#record);
        },
      },
      kept: this.deps.kept,
      // Matched to the Mac's folders when the list joins them (the next unit); none on their own.
      projects: () => [],
      fetch: this.deps.fetch,
      connect: this.deps.connect,
      push: this.deps.push,
      // OS alerts for cloud threads come from the server, not from here.
      notify: () => undefined,
      deviceName: PHONE_DEVICE,
      now: this.deps.now,
      log: this.deps.log,
    });
    this.#hosted = hosted;
    await hosted.start();
    this.#told();
    return hosted;
  }

  /** Signs the phone's own session out at the server, forgets it and what it kept, and closes its socket. */
  async #drop(): Promise<void> {
    const hosted = this.#hosted;
    if (!hosted) return;
    this.#hosted = null;
    this.#server = null;
    await hosted.account.signOut().catch(() => undefined);
    hosted.close();
    this.#record = null;
    await this.deps.vault.save(null);
    this.deps.kept.forget();
    this.#told();
  }

  #serial(work: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #told(): void {
    this.#listeners.forEach((listener) => listener());
  }
}
