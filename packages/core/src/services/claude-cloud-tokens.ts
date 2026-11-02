import { mkdirSync } from "node:fs";
import { stripAnsi } from "@openorc/agents";
import type { ClaudeCloudAccess } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";
import { spawnWithPipes, type SpawnTerminal } from "./terminal-process.js";

const storageError = "Cannot access protected storage for Claude cloud tokens. Unlock your OS keychain and retry.";
/** How `claude setup-token` prints the token it made. */
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
/** What setup-token's screen shows when the sign-in failed, above a hint to press Enter to try again, which it waits for. */
const FAILED = /OAuth error: ([^\r\n]+)/;
const RETRY = /Press Enter to retry\./;
/** The screen setup-token falls back to when the browser cannot hand the sign-in back to it. */
const PASTE_PROMPT = /Paste code here/;
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** More output than a sign-in prints means something else is talking; the token would be in the first part. */
const OUTPUT_LIMIT = 64 * 1024;

interface Saved {
  token: string;
  createdAt: number;
}

/** What token creation needs from the Claude accounts, and what they hear of a token saved or removed. */
export interface ClaudeSignIn {
  signInLaunch(id: string): { binary: string; env: NodeJS.ProcessEnv; directory: string };
  cloudTokenChanged?(id: string): void;
}

/**
 * Long-lived Claude tokens that let each Claude account's agents sign in inside cloud sandboxes, one per account. A token
 * is made by `claude setup-token` through the account's own browser sign-in, or pasted, and kept only in main's protected
 * store. A token can run the model and nothing else.
 */
export class ClaudeCloudTokens {
  private pending: Promise<unknown> = Promise.resolve();
  private cache: Record<string, Saved> | null = null;
  private readonly creating = new Map<string, { stop: () => void; cancelled: boolean }>();
  private readonly errors = new Map<string, string>();
  private closing = false;

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    private readonly accounts: ClaudeSignIn,
    private readonly changed: () => void,
    /** setup-token draws its screen and finishes only in a terminal; the app passes one. */
    private readonly terminal: SpawnTerminal = spawnWithPipes,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private async read(): Promise<Record<string, Saved>> {
    if (this.cache) return this.cache;
    if (!this.store) return {};
    let raw: string | null;
    try {
      raw = await this.store.load();
    } catch {
      throw new Error(storageError);
    }
    this.cache = raw ? (JSON.parse(raw) as Record<string, Saved>) : {};
    return this.cache;
  }

  private async write(next: Record<string, Saved>): Promise<void> {
    try {
      if (!this.store) throw new Error(storageError);
      await this.store.save(JSON.stringify(next));
    } catch {
      throw new Error(storageError);
    }
    this.cache = next;
  }

  /** By account id, only the accounts with something to report. */
  status(): Promise<Record<string, ClaudeCloudAccess>> {
    return this.serialize(async () => {
      const saved = await this.read();
      const ids = new Set([...Object.keys(saved), ...this.creating.keys(), ...this.errors.keys()]);
      return Object.fromEntries([...ids].map((id) => [id, { createdAt: saved[id]?.createdAt ?? null, creating: this.creating.has(id), error: this.errors.get(id) ?? null }]));
    });
  }

  /** The token an account's agents sign in with inside a sandbox, or null when it has none. */
  token(id: string): Promise<string | null> {
    return this.serialize(async () => (await this.read())[id]?.token ?? null);
  }

  /** Reads the tokens once, so `known` can answer without waiting. */
  async load(): Promise<void> {
    await this.serialize(() => this.read());
  }

  /** The account's token from the tokens already read; null for an account without one, or before `load`. */
  known(id: string): string | null {
    return this.cache?.[id]?.token ?? null;
  }

  /** Saves a token made elsewhere. A pasted `export CLAUDE_CODE_OAUTH_TOKEN=…` line keeps just the token. */
  save(id: string, pasted: string): Promise<void> {
    const token = TOKEN.exec(pasted)?.[0] ?? pasted.trim();
    return this.serialize(async () => {
      await this.write({ ...(await this.read()), [id]: { token, createdAt: Date.now() } });
      this.errors.delete(id);
      this.accounts.cloudTokenChanged?.(id);
    });
  }

  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const { [id]: _removed, ...rest } = await this.read();
      await this.write(rest);
      this.errors.delete(id);
      this.accounts.cloudTokenChanged?.(id);
    });
  }

  /**
   * Starts `claude setup-token` for the account. Its browser sign-in finishes it: the token is saved as soon as its
   * screen shows it, and the command is closed then, or as soon as it shows that the sign-in failed.
   */
  async create(id: string): Promise<void> {
    if (this.closing) throw new Error("OpenOrc is closing.");
    if (this.creating.has(id)) return;
    const attempt = { stop: () => undefined as void, cancelled: false };
    this.errors.delete(id);
    this.creating.set(id, attempt);
    this.changed();
    try {
      const { binary, env, directory } = this.accounts.signInLaunch(id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const proc = await this.terminal(binary, ["--setting-sources", "user", "setup-token"], { cwd: directory, env });
      attempt.stop = () => proc.kill();
      if (attempt.cancelled) proc.kill();
      let screen = "";
      let token: string | null = null;
      proc.onData((chunk) => {
        if (token || screen.length >= OUTPUT_LIMIT) return;
        screen += chunk;
        const text = stripAnsi(screen);
        token = TOKEN.exec(text)?.[0] ?? null;
        const failure = token ? null : this.failure(text);
        if (failure) this.errors.set(id, failure);
        if (token || failure) proc.kill();
      });
      const timer = setTimeout(() => proc.kill(), CREATE_TIMEOUT_MS);
      timer.unref();
      proc.onExit((code) => {
        clearTimeout(timer);
        this.creating.delete(id);
        void this.finish(id, attempt.cancelled, code, token);
      });
    } catch {
      this.creating.delete(id);
      this.errors.set(id, "Claude could not start making a token. Check its installation and retry.");
      this.changed();
    }
  }

  /** Why setup-token's screen says the sign-in failed, in its own words; null while it has not. */
  private failure(screen: string): string | null {
    const retry = screen.search(RETRY);
    // Some failures are shown as they are, without the prefix: the line above the hint says why.
    const failed =
      FAILED.exec(screen)?.[1]?.trim() ??
      (retry >= 0
        ? screen
            .slice(0, retry)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1)
        : null);
    if (failed) return `The sign-in failed: ${failed.replace(TOKEN, "")}`;
    if (PASTE_PROMPT.test(screen)) return "The browser could not hand the sign-in back to Claude. Run claude setup-token in Terminal and paste the token.";
    return null;
  }

  /** The command's output holds the token, so no error ever repeats it. */
  private async finish(id: string, cancelled: boolean, code: number | null, token: string | null): Promise<void> {
    try {
      if (token && !cancelled) await this.save(id, token);
      else if (!cancelled && !this.errors.has(id))
        this.errors.set(id, code === 0 ? "Claude finished without a token. Paste one from claude setup-token instead." : "Making the token did not finish. Retry and complete the browser sign-in.");
    } catch (error) {
      this.errors.set(id, error instanceof Error ? error.message : storageError);
    } finally {
      this.changed();
    }
  }

  cancel(id: string): void {
    const attempt = this.creating.get(id);
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.stop();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const id of [...this.creating.keys()]) this.cancel(id);
    await this.pending;
  }
}
