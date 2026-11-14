/** Mounts `@openorc/hosted` in the Mac's core: hands it what only this Mac has. Handlers call the package's own account. */
import { projects, settings, type Db } from "@openorc/db";
import { createHosted, type Hosted, type LiveSocket } from "@openorc/hosted";
import { ACCOUNT_PROTOCOL_HEADER, ACCOUNT_PROTOCOL_VERSION } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import type { OpenOrcOptions } from "../options.js";
import type { Logger, Transport } from "../transport.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";
import { mintClaudeToken, type ClaudeSignInLaunch } from "./claude-token-mint.js";
import { awaitBrowserReturn } from "./browser-return.js";
import { noticeLine } from "./notice-text.js";
import { spawnWithPipes, type SpawnTerminal } from "./terminal-process.js";

/** What the server last said, by part, in the settings table. */
const KEPT = { account: "hosted.kept", threads: "hosted.threads" } as const;
const STORAGE = "Cannot access protected storage for your OpenOrc account. Unlock your OS keychain and retry.";
/** How long a socket the server answered with an error other than a refusal waits before trying again. */
const RETRY_MS = 10_000;
/** How long the server has to answer a message on the socket. */
const ASK_MS = 10_000;
/** A notice's body, as long as this Mac's own turn notices are. */
const NOTICE_CHARS = 140;

export interface AccountDeps {
  db: Db;
  server: string;
  /** Main's `account.secrets` channel. Without it nobody can sign in. */
  secrets: ProtectedSecretStore | undefined;
  /** The windows alone, before the phone tap: nothing of the account reaches a paired phone. */
  windows: Transport;
  /** Whether "Desktop notifications" is on. */
  notices(): boolean;
  /** This Mac's Claude accounts, which make the token of a Claude sign-in on OpenOrc Cloud with `claude setup-token`. */
  claude: ClaudeSignInLaunch & { defaultId(): string };
  terminal: SpawnTerminal | undefined;
  openBrowser: ((url: string) => void) | undefined;
  log: Logger;
}

/** The account for this core: none on the cloud brain, or with no account server. */
export function accountFor(
  options: Pick<OpenOrcOptions, "cloudOnly" | "accountServer" | "accountSecrets" | "terminal" | "openBrowser">,
  parts: Omit<AccountDeps, "server" | "secrets" | "terminal" | "openBrowser">,
): Hosted | null {
  if (options.cloudOnly || !options.accountServer) return null;
  return createAccount({ ...parts, server: options.accountServer, secrets: options.accountSecrets, terminal: options.terminal, openBrowser: options.openBrowser });
}

/** The account for this Mac. Made only for a core given an account server. */
function createAccount(deps: AccountDeps): Hosted {
  return createHosted({
    server: deps.server,
    session: sessionStore(deps.secrets),
    kept: {
      load: (part) => settings.get(deps.db, KEPT[part]),
      save: (part, json) => (json === null ? settings.remove(deps.db, KEPT[part]) : settings.set(deps.db, KEPT[part], json)),
    },
    projects: () => projects.list(deps.db).map((project) => ({ id: project.id, remote: project.gitRemote })),
    fetch,
    connect: liveSocket,
    push: (push) => deps.windows.push(push),
    notify: (notice) => {
      if (deps.notices()) deps.windows.push({ type: "notify", ...notice, body: noticeLine(notice.body, NOTICE_CHARS), id: randomUUID() });
    },
    mintClaudeToken: (id) => mintClaudeToken(deps.claude, deps.terminal ?? spawnWithPipes, id ?? deps.claude.defaultId()),
    ...(deps.openBrowser && { browser: { awaitReturn: awaitBrowserReturn, open: deps.openBrowser } }),
    deviceName: process.platform === "darwin" ? "OpenOrc on this Mac" : "OpenOrc on this computer",
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
    on: (event, listener) => void socket.on(event, listener),
    ask: (event, body) => socket.timeout(ASK_MS).emitWithAck(event, body) as Promise<unknown>,
    close: () => {
      if (retry) clearTimeout(retry);
      socket.close();
    },
  };
}
