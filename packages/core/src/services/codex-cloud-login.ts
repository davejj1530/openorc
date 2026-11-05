import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripAnsi, withCodexConnection } from "@openorc/agents";
import type { HandoverCodexLogin } from "@openorc/cloud";
import type { CodexCloudAccess } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";
import type { SpawnTerminal, TerminalProcess } from "./terminal-process.js";

const storageError = "Cannot access protected storage for the Codex cloud sign-in. Unlock your OS keychain and retry.";
/** Codex keeps its login in a file there, never in the OS keychain, so the file is the login. */
export const CODEX_FILE_STORE = 'cli_auth_credentials_store = "file"\n';
/** A ChatGPT login is refreshed here before a sandbox gets it once its last refresh is this old. Its access lasts 10 days. */
const REFRESH_AFTER_MS = 24 * 60 * 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

interface Stored {
  mode: "chatgpt" | "apiKey";
  /** Codex's auth.json, as Codex writes it. */
  auth: string;
  email: string | null;
  plan: string | null;
  savedAt: number;
  /** The Mac's name for a login it made for this host alone, as for the cloud brain. */
  id?: string;
}

/** A ChatGPT login Codex made, and who it belongs to. */
export interface CodexLogin {
  auth: string;
  email: string | null;
  plan: string | null;
}

/** Codex's auth.json for an OpenAI API key: billed by the token to that key's organization, with no ChatGPT plan involved. */
export const apiKeyAuth = (key: string): string => JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key.trim() });

export interface CodexDeps {
  binary(): string | null;
  env(): NodeJS.ProcessEnv;
  terminal: SpawnTerminal;
  changed(): void;
}

/** When Codex last refreshed a ChatGPT login file, in ms; 0 when it does not say. */
function lastRefresh(auth: string): number {
  try {
    const when = (JSON.parse(auth) as { last_refresh?: unknown }).last_refresh;
    return typeof when === "string" ? Date.parse(when) || 0 : 0;
  } catch {
    return 0;
  }
}

function binaryOf(deps: CodexDeps): string {
  const binary = deps.binary();
  if (!binary) throw new Error("Codex is not installed on this Mac. Install it, then sign in for the cloud.");
  return binary;
}

/** Runs Codex in a private folder holding the login, and keeps what Codex left there. */
async function inFolder<T>(auth: string | null, work: (home: string) => Promise<T>): Promise<{ result: T; auth: string | null }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "openorc-codex-cloud-"));
  try {
    await writeFile(path.join(home, "config.toml"), CODEX_FILE_STORE, { mode: 0o600 });
    if (auth) await writeFile(path.join(home, "auth.json"), auth, { mode: 0o600 });
    const result = await work(home);
    return { result, auth: await readFile(path.join(home, "auth.json"), "utf8").catch(() => null) };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Who the login belongs to, as Codex reads it. With `refresh`, Codex refreshes it first. */
function account(deps: CodexDeps, home: string, refresh: boolean): Promise<{ email: string | null; plan: string | null }> {
  return withCodexConnection({ binary: binaryOf(deps), env: { ...deps.env(), CODEX_HOME: home } }, async (rpc) => {
    const read = await rpc.request<{ account?: { type?: string; email?: string | null; planType?: string | null } | null }>("account/read", refresh ? { refreshToken: true } : {}, 15_000);
    return { email: read.account?.email ?? null, plan: read.account?.planType ?? null };
  });
}

/** One ChatGPT sign-in in the browser at a time, in a private folder: Codex opens the browser, and the login it made is handed on. */
export class CodexBrowserSignIn {
  private signing: { proc: TerminalProcess | null; cancelled: boolean } | null = null;
  private done: Promise<void> = Promise.resolve();
  /** Why the last sign-in did not finish. */
  error: string | null = null;

  constructor(private readonly deps: CodexDeps) {}

  get signingIn(): boolean {
    return this.signing !== null;
  }

  /** Opens the browser unless a sign-in is open already; `take` gets the login once it is made, before the sign-in ends. */
  start(take: (login: CodexLogin) => Promise<void>): void {
    if (this.signing) return;
    const attempt: { proc: TerminalProcess | null; cancelled: boolean } = { proc: null, cancelled: false };
    this.signing = attempt;
    this.error = null;
    this.deps.changed();
    const finished = inFolder(null, async (home) => {
      const proc = await this.deps.terminal(binaryOf(this.deps), ["login"], { cwd: home, env: { ...this.deps.env(), CODEX_HOME: home } });
      attempt.proc = proc;
      if (attempt.cancelled) proc.kill();
      let screen = "";
      proc.onData((chunk) => {
        if (screen.length < 64 * 1024) screen += chunk;
      });
      const timer = setTimeout(() => proc.kill(), SIGN_IN_TIMEOUT_MS);
      timer.unref();
      const code = await new Promise<number | null>((resolve) => proc.onExit(resolve));
      clearTimeout(timer);
      if (code !== 0 || attempt.cancelled) return { code, said: stripAnsi(screen).trim().split("\n").at(-1) ?? "", who: null };
      return { code, said: "", who: await account(this.deps, home, false) };
    });
    this.done = finished
      .then(async ({ result, auth }) => {
        if (attempt.cancelled) return;
        if (!auth || !result.who) {
          this.error = result.said ? `The sign-in did not finish: ${result.said}` : "The sign-in did not finish. Try again and complete it in the browser.";
          return;
        }
        await take({ auth, ...result.who });
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.signing = null;
        this.deps.changed();
      });
  }

  cancel(): void {
    if (!this.signing) return;
    this.signing.cancelled = true;
    this.signing.proc?.kill();
  }

  /** Once the sign-in open now ended, its login handed on or not. */
  finished(): Promise<void> {
    return this.done;
  }
}

/**
 * The Codex login cloud sandboxes use: a ChatGPT sign-in of its own, separate from this Mac's `codex login`, or an
 * OpenAI API key. A ChatGPT login's refresh token works once, so only this host refreshes it: a day-old login is refreshed
 * here before a sandbox gets it, and a sandbox that had to refresh it hands the new one back after its turn. The file is
 * kept only in main's protected store; it exists on disk only in a private folder while Codex reads or writes it.
 */
export class CodexCloudLogin {
  private pending: Promise<unknown> = Promise.resolve();
  private cache: Stored | null | undefined;
  private readonly browser: CodexBrowserSignIn;

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    private readonly deps: CodexDeps,
  ) {
    this.browser = new CodexBrowserSignIn(deps);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private async read(): Promise<Stored | null> {
    if (this.cache !== undefined) return this.cache;
    if (!this.store) return null;
    let raw: string | null;
    try {
      raw = await this.store.load();
    } catch {
      throw new Error(storageError);
    }
    this.cache = raw ? (JSON.parse(raw) as Stored) : null;
    return this.cache;
  }

  private async write(next: Stored | null): Promise<void> {
    try {
      if (!this.store) throw new Error(storageError);
      await this.store.save(next ? JSON.stringify(next) : "");
    } catch {
      throw new Error(storageError);
    }
    this.cache = next;
  }

  status(): Promise<CodexCloudAccess> {
    return this.serialize(async () => {
      const stored = await this.read();
      return {
        mode: stored?.mode ?? null,
        email: stored?.email ?? null,
        plan: stored?.plan ?? null,
        refreshedAt: stored ? lastRefresh(stored.auth) || stored.savedAt : null,
        signingIn: this.browser.signingIn,
        error: this.browser.error,
      };
    });
  }

  /** Starts a ChatGPT sign-in for the cloud: Codex opens the browser, and the login it makes is kept here. */
  async signIn(): Promise<void> {
    this.browser.start((login) => this.serialize(() => this.write({ mode: "chatgpt", ...login, savedAt: Date.now() })));
  }

  cancel(): void {
    this.browser.cancel();
  }

  /** Once the ChatGPT sign-in open now ended, its login kept or not. */
  finished(): Promise<void> {
    return this.browser.finished();
  }

  /** An OpenAI API key: billed by the token to that key's organization, with no ChatGPT plan involved. */
  saveApiKey(key: string): Promise<void> {
    return this.serialize(async () => {
      this.browser.error = null;
      await this.write({ mode: "apiKey", auth: apiKeyAuth(key), email: null, plan: null, savedAt: Date.now() });
    });
  }

  remove(): Promise<void> {
    return this.serialize(async () => {
      this.browser.error = null;
      await this.write(null);
      this.deps.changed();
    });
  }

  /** The Mac's name for the login made for this host that it holds; null when it holds none, or one of its own. */
  heldId(): Promise<string | null> {
    return this.serialize(async () => (await this.read().catch(() => null))?.id ?? null);
  }

  /**
   * A login made elsewhere for this host alone, as the Mac hands the cloud brain one. The same login handed over again
   * changes nothing, so what this host refreshed since is kept.
   */
  adopt({ id, mode, auth, email, plan }: HandoverCodexLogin): Promise<void> {
    return this.serialize(async () => {
      if ((await this.read())?.id === id) return;
      await this.write({ mode, auth, email, plan, savedAt: Date.now(), id });
      this.deps.changed();
    });
  }

  has(): Promise<boolean> {
    return this.serialize(async () => Boolean(await this.read().catch(() => null)));
  }

  /** The login file a sandbox gets, refreshed here first when it is a day old; null without one. */
  forSandbox(): Promise<string | null> {
    return this.serialize(async () => {
      const stored = await this.read();
      if (!stored) return null;
      if (stored.mode !== "chatgpt" || Date.now() - lastRefresh(stored.auth) < REFRESH_AFTER_MS) return stored.auth;
      const { result, auth } = await inFolder(stored.auth, (home) => account(this.deps, home, true));
      if (!auth) throw new Error("Codex left no login after refreshing it. Sign in for the cloud again in Settings.");
      await this.write({ ...stored, auth, email: result.email ?? stored.email, plan: result.plan ?? stored.plan });
      return auth;
    });
  }

  /** A sandbox's login file after its turn: kept when Codex refreshed it there, so the next sandbox gets the live one. */
  keep(auth: string): Promise<void> {
    return this.serialize(async () => {
      const stored = await this.read();
      if (stored?.mode !== "chatgpt" || lastRefresh(auth) <= lastRefresh(stored.auth)) return;
      await this.write({ ...stored, auth });
    });
  }
}
