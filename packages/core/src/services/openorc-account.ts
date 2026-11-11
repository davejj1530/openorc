/** Mounts `@openorc/hosted` in the Mac's core: hands it what only this Mac has. Handlers call the package's own account. */
import { settings, type Db } from "@openorc/db";
import { createHosted, type Hosted, type LiveSocket } from "@openorc/hosted";
import { ACCOUNT_PROTOCOL_HEADER, ACCOUNT_PROTOCOL_VERSION } from "@openorc/protocol";
import { io } from "socket.io-client";
import type { Logger, Transport } from "../transport.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

const KEPT = "hosted.kept";
const STORAGE = "Cannot access protected storage for your OpenOrc account. Unlock your OS keychain and retry.";
/** How long a socket the server answered with an error other than a refusal waits before trying again. */
const RETRY_MS = 10_000;

export interface AccountDeps {
  db: Db;
  server: string;
  /** Main's `account.secrets` channel. Without it nobody can sign in. */
  secrets: ProtectedSecretStore | undefined;
  /** The windows alone, before the phone tap: nothing of the account reaches a paired phone. */
  windows: Transport;
  log: Logger;
}

/** The account for this Mac. Made only for a core given an account server. */
export function createAccount(deps: AccountDeps): Hosted {
  return createHosted({
    server: deps.server,
    session: sessionStore(deps.secrets),
    kept: {
      load: () => settings.get(deps.db, KEPT),
      save: (json) => (json === null ? settings.remove(deps.db, KEPT) : settings.set(deps.db, KEPT, json)),
    },
    fetch,
    connect: liveSocket,
    push: (push) => deps.windows.push(push),
    now: Date.now,
    log: deps.log,
  });
}

/**
 * The session in main's protected storage, as the one value of its channel. An empty value records a sign-out. Errors
 * are replaced by words of our own, so neither the OS nor main can carry the token into a log or a reply.
 */
function sessionStore(secrets: ProtectedSecretStore | undefined): { load(): Promise<string | null>; save(value: string | null): Promise<void> } {
  return {
    load: async () => {
      if (!secrets) return null;
      try {
        return (await secrets.load()) || null;
      } catch {
        throw new Error(STORAGE);
      }
    },
    save: async (value) => {
      try {
        if (!secrets) throw new Error(STORAGE);
        await secrets.save(value ?? "");
      } catch {
        throw new Error(STORAGE);
      }
    },
  };
}

/** `socket.io-client` on the websocket transport alone, as the server offers, with the token in the handshake's `auth`. */
function liveSocket(url: string, token: string): LiveSocket {
  const socket = io(url, { transports: ["websocket"], auth: { token }, extraHeaders: { [ACCOUNT_PROTOCOL_HEADER]: String(ACCOUNT_PROTOCOL_VERSION) }, reconnectionDelayMax: 60_000 });
  let retry: ReturnType<typeof setTimeout> | null = null;
  const listeners: ((state: "up" | "down" | "refused") => void)[] = [];
  const emit = (state: "up" | "down" | "refused") => listeners.forEach((listener) => listener(state));
  socket.on("connect", () => emit("up"));
  socket.on("disconnect", () => emit("down"));
  socket.on("connect_error", (error) => {
    if (error.message === "UNAUTHORIZED") return emit("refused");
    emit("down");
    // A refusal from the server's handshake stops the client's own retries; the network's errors do not.
    if (!socket.active) retry = setTimeout(() => socket.connect(), RETRY_MS);
  });
  return {
    onState: (listener) => void listeners.push(listener),
    close: () => {
      if (retry) clearTimeout(retry);
      socket.close();
    },
  };
}
