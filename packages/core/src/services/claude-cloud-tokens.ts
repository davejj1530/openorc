import type { ClaudeCloudAccess } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";
import { CLAUDE_TOKEN, mintClaudeToken, type ClaudeSignInLaunch } from "./claude-token-mint.js";
import { spawnWithPipes, type SpawnTerminal } from "./terminal-process.js";

const storageError = "Cannot access protected storage for Claude cloud tokens. Unlock your OS keychain and retry.";

interface Saved {
  token: string;
  createdAt: number;
}

/** What token creation needs from the Claude accounts, and what they hear of a token saved or removed. */
export interface ClaudeSignIn extends ClaudeSignInLaunch {
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
  private readonly creating = new Map<string, { stop: () => void; cancelled: boolean; done: Promise<void> }>();
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
    const token = CLAUDE_TOKEN.exec(pasted)?.[0] ?? pasted.trim();
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
   * Starts `claude setup-token` for the account (claude-token-mint.ts). Its browser sign-in finishes it: the token is
   * saved as soon as its screen shows it, or the attempt ends with the CLI's words for why it failed.
   */
  async create(id: string): Promise<void> {
    if (this.closing) throw new Error("OpenOrc is closing.");
    if (this.creating.has(id)) return;
    let settle = () => undefined as void;
    const mint = mintClaudeToken(this.accounts, this.terminal, id);
    const attempt = { stop: () => mint.cancel(), cancelled: false, done: new Promise<void>((resolve) => (settle = resolve)) };
    this.errors.delete(id);
    this.creating.set(id, attempt);
    this.changed();
    void mint.token
      .then(
        (token) => this.save(id, token),
        (error: unknown) => {
          const words = error instanceof Error ? error.message : storageError;
          if (words && !attempt.cancelled) this.errors.set(id, words);
        },
      )
      .catch((error: unknown) => this.errors.set(id, error instanceof Error ? error.message : storageError))
      .finally(() => {
        this.creating.delete(id);
        this.changed();
        settle();
      });
  }

  /** Once the account's token in the making is saved, or its attempt ended without one. */
  finished(id: string): Promise<void> {
    return this.creating.get(id)?.done ?? Promise.resolve();
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
