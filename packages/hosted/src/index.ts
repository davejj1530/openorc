/**
 * OpenOrc Cloud, as the app speaks to it. The whole public surface of the package: `exports` in package.json names this
 * file and the test stand-in, so session.ts, wire.ts, account.ts and translate.ts cannot be imported from outside.
 *
 * What it hides: the server's routes and their shapes, the bearer token, the socket and reach. What it shows: the
 * app's own protocol types and nothing of the server's.
 *
 * No Node, Electron or React Native import outside testing/. Each host hands in what only it has (`HostedDeps`), so a
 * phone can mount the same package with its own storage.
 */
import type { AccountStatus } from "@openorc/protocol";
import { Account } from "./account.js";
import { Session } from "./session.js";

/** The server's push socket, as little of it as the package uses. The desktop core builds one from `socket.io-client`. */
export interface LiveSocket {
  /** `up` on every new session, `down` when it drops, `refused` when the server will not take the token. */
  onState(listener: (state: "up" | "down" | "refused") => void): void;
  close(): void;
}

/** What only the host has. Everything else is the package's own. */
export interface HostedDeps {
  /** The server's origin. Tests pass their stand-in's. */
  server: string;
  /**
   * Keeps the signed-in session (its token and address, as one opaque value) in protected storage. The package reads
   * it once at start, holds it in memory, and never returns, logs or throws the token. `save(null)` forgets it.
   */
  session: { load(): Promise<string | null>; save(value: string | null): Promise<void> };
  /** Keeps what the server last said that is no secret (the plan and hours), so it shows offline and after a restart. */
  kept: { load(): string | null; save(json: string | null): void };
  fetch: typeof fetch;
  /** Opens the socket with the token. Called again after each sign-in and each early reconnect; it retries by itself in between. */
  connect(url: string, token: string): LiveSocket;
  /** What the host's windows hear. Never reaches a paired phone. */
  push(push: { type: "invalidate"; keys: string[] }): void;
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

/** The account: who is signed in and what they pay for. */
export interface HostedAccount {
  /** What is known now, without waiting. Changes are announced with `invalidate ["account"]`. */
  status(): AccountStatus;
  sendCode(email: string): Promise<void>;
  /** Nothing to do when already signed in as the same address. The session is in protected storage before this resolves. */
  signIn(email: string, code: string): Promise<void>;
  /** Forgets the session and the kept answers first, then tells the server, so a server out of reach still signs out here. */
  signOut(): Promise<void>;
}

export interface Hosted {
  readonly account: HostedAccount;
  /** Reads the stored session and the kept answers, and connects when signed in. Never rejects: no session is signed out. */
  start(): Promise<void>;
  /** The device woke or the network came back: connect now instead of at the next retry. */
  awoke(): void;
  close(): void;
}

export function createHosted(deps: HostedDeps): Hosted {
  const session = new Session(deps);
  const account = new Account({ session, kept: deps.kept, push: deps.push, now: deps.now });
  return {
    account,
    start: () => account.start(),
    awoke: () => session.awoke(),
    close: () => session.close(),
  };
}
