import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { launchCommand, stopProcess, stripAnsi } from "@openorc/agents";
import type { ClaudeCloudAccess } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

const storageError = "Cannot access protected storage for Claude cloud tokens. Unlock your OS keychain and retry.";
/** How `claude setup-token` prints the token it made. */
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** More output than a sign-in prints means something else is talking; the token would be in the first part. */
const OUTPUT_LIMIT = 64 * 1024;

interface Saved {
  token: string;
  createdAt: number;
}

/** What token creation needs from the Claude accounts. */
export interface ClaudeSignIn {
  signInLaunch(id: string): { binary: string; env: NodeJS.ProcessEnv; directory: string };
}

/**
 * Long-lived Claude tokens that let each Claude account's agents sign in inside cloud sandboxes, one per account. A token
 * is made by `claude setup-token` through the account's own browser sign-in, or pasted, and kept only in main's protected
 * store. A token can run the model and nothing else.
 */
export class ClaudeCloudTokens {
  private pending: Promise<unknown> = Promise.resolve();
  private cache: Record<string, Saved> | null = null;
  private readonly creating = new Map<string, { child: ChildProcess; cancelled: boolean }>();
  private readonly errors = new Map<string, string>();
  private closing = false;

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    private readonly accounts: ClaudeSignIn,
    private readonly changed: () => void,
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

  /** Saves a token made elsewhere. A pasted `export CLAUDE_CODE_OAUTH_TOKEN=…` line keeps just the token. */
  save(id: string, pasted: string): Promise<void> {
    const token = TOKEN.exec(pasted)?.[0] ?? pasted.trim();
    return this.serialize(async () => {
      await this.write({ ...(await this.read()), [id]: { token, createdAt: Date.now() } });
      this.errors.delete(id);
    });
  }

  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const { [id]: _removed, ...rest } = await this.read();
      await this.write(rest);
      this.errors.delete(id);
    });
  }

  /** Starts `claude setup-token` for the account. Its browser sign-in finishes it, and the token it prints is saved. */
  create(id: string): void {
    if (this.closing) throw new Error("OpenOrc is closing.");
    if (this.creating.has(id)) return;
    const { binary, env, directory } = this.accounts.signInLaunch(id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const command = launchCommand(binary, ["--setting-sources", "user", "setup-token"]);
    const child = spawn(command.file, command.args, { ...command.options, env, cwd: directory, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const attempt = { child, cancelled: false };
    this.errors.delete(id);
    this.creating.set(id, attempt);
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => stopProcess(child), CREATE_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => this.errors.set(id, "Claude could not start making a token. Check its installation and retry."));
    child.once("close", (code) => {
      clearTimeout(timer);
      this.creating.delete(id);
      void this.finish(id, attempt.cancelled, code, TOKEN.exec(stripAnsi(output))?.[0] ?? null);
    });
    this.changed();
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
    stopProcess(attempt.child);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const id of [...this.creating.keys()]) this.cancel(id);
    await this.pending;
  }
}
