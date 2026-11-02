import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripAnsi, withCodexConnection } from "@openorc/agents";
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

/**
 * The Codex login cloud sandboxes use: a ChatGPT sign-in of its own, separate from this Mac's `codex login`, or an
 * OpenAI API key. A ChatGPT login's refresh token works once, so only this Mac refreshes it: a day-old login is refreshed
 * here before a sandbox gets it, and a sandbox that had to refresh it hands the new one back after its turn. The file is
 * kept only in main's protected store; it exists on disk only in a private folder while Codex reads or writes it.
 */
export class CodexCloudLogin {
  private pending: Promise<unknown> = Promise.resolve();
  private cache: Stored | null | undefined;
  private signing: { proc: TerminalProcess | null; cancelled: boolean } | null = null;
  private error: string | null = null;

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    private readonly deps: { binary(): string | null; env(): NodeJS.ProcessEnv; terminal: SpawnTerminal; changed(): void },
  ) {}

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
        signingIn: Boolean(this.signing),
        error: this.error,
      };
    });
  }

  private binary(): string {
    const binary = this.deps.binary();
    if (!binary) throw new Error("Codex is not installed on this Mac. Install it, then sign in for the cloud.");
    return binary;
  }

  /** Runs Codex in a private folder holding the login, and keeps what Codex left there. */
  private async inFolder<T>(auth: string | null, work: (home: string) => Promise<T>): Promise<{ result: T; auth: string | null }> {
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
  private account(home: string, refresh: boolean): Promise<{ email: string | null; plan: string | null }> {
    return withCodexConnection({ binary: this.binary(), env: { ...this.deps.env(), CODEX_HOME: home } }, async (rpc) => {
      const read = await rpc.request<{ account?: { type?: string; email?: string | null; planType?: string | null } | null }>("account/read", refresh ? { refreshToken: true } : {}, 15_000);
      return { email: read.account?.email ?? null, plan: read.account?.planType ?? null };
    });
  }

  /** Starts a ChatGPT sign-in for the cloud: Codex opens the browser, and the login it makes is kept here. */
  async signIn(): Promise<void> {
    if (this.signing) return;
    const attempt: { proc: TerminalProcess | null; cancelled: boolean } = { proc: null, cancelled: false };
    this.signing = attempt;
    this.error = null;
    this.deps.changed();
    const finished = this.inFolder(null, async (home) => {
      const proc = await this.deps.terminal(this.binary(), ["login"], { cwd: home, env: { ...this.deps.env(), CODEX_HOME: home } });
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
      return { code, said: "", who: await this.account(home, false) };
    });
    void finished
      .then(async ({ result, auth }) => {
        if (attempt.cancelled) return;
        if (!auth || !result.who) {
          this.error = result.said ? `The sign-in did not finish: ${result.said}` : "The sign-in did not finish. Try again and complete it in the browser.";
          return;
        }
        await this.serialize(() => this.write({ mode: "chatgpt", auth, email: result.who!.email, plan: result.who!.plan, savedAt: Date.now() }));
      })
      .catch((error: unknown) => (this.error = error instanceof Error ? error.message : String(error)))
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

  /** An OpenAI API key: billed by the token to that key's organization, with no ChatGPT plan involved. */
  saveApiKey(key: string): Promise<void> {
    return this.serialize(async () => {
      this.error = null;
      await this.write({ mode: "apiKey", auth: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key.trim() }), email: null, plan: null, savedAt: Date.now() });
    });
  }

  remove(): Promise<void> {
    return this.serialize(async () => {
      this.error = null;
      await this.write(null);
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
      const { result, auth } = await this.inFolder(stored.auth, (home) => this.account(home, true));
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
