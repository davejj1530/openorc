import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SHARED_CLAUDE_CONFIG_DIR, captureLaunchEnvironment, claudeConfigDir, launchCommand, stopProcess } from "@openorc/agents";
import { chromeExecutable, chromeIncognitoFlags } from "@openorc/agents/chrome-incognito";
import { claudeAccounts, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, type ClaudeAccount, type ClaudeAccountConnection, type ClaudeAccounts } from "@openorc/protocol";
import { z } from "zod";
import type { EnvSnapshot } from "./shell-environment.js";

const authStatus = z.object({ loggedIn: z.boolean(), email: z.string().nullable().optional(), orgName: z.string().nullable().optional() });
const inheritedAuth = /^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|OAUTH_TOKEN_FILE_DESCRIPTOR|API_KEY_FILE_DESCRIPTOR|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)|CLAUDE_CONFIG_DIR$)/;
type Connection = Pick<ClaudeAccountConnection, "status" | "email" | "organization" | "message">;
const disconnected: Connection = { status: "signed_out", email: null, organization: null, message: null };

/**
 * An added account uses the personal skills installed for the existing CLI login: each is linked into the
 * account's own skills folder, where both Claude Code and the composer's / list find it. A link goes once its
 * skill is uninstalled. The account's own skills and the claude.ai skills Claude Code syncs into `synced` stay.
 * This runs whenever the account's environment is built, so a newly installed skill is linked by the next refresh.
 */
function linkSharedSkills(shared: string, account: string): void {
  // Before sign-in the folder does not exist, and creating it here would skip the private mode sign-in gives it.
  if (!existsSync(account)) return;
  const from = path.join(shared, "skills");
  const to = path.join(account, "skills");
  const linkable = (entry: Dirent) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== "synced" && !entry.name.startsWith(".");
  let installed: Set<string>;
  let present: Dirent[];
  try {
    installed = new Set(
      existsSync(from)
        ? readdirSync(from, { withFileTypes: true })
            .filter(linkable)
            .map((entry) => entry.name)
        : [],
    );
    mkdirSync(to, { recursive: true });
    present = readdirSync(to, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of present) {
    const link = path.join(to, entry.name);
    try {
      if (entry.isSymbolicLink() && !installed.has(entry.name) && path.dirname(readlinkSync(link)) === from) unlinkSync(link);
    } catch {
      // A link that cannot be removed is a skill Claude reports missing, not a reason to stop the run.
    }
  }
  const existing = new Set(present.map((entry) => entry.name));
  for (const name of installed) {
    if (existing.has(name)) continue;
    try {
      symlinkSync(path.join(from, name), path.join(to, name), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // That one skill stays out of this account; the rest still link.
    }
  }
}

/**
 * Memories an added account saved in its own folder, before it shared the CLI login's, move to the CLI login's folder
 * for the same project, where its runs now look. Index lines are added once; a file whose name already holds a
 * different memory stays where it is, and so does the account's folder around it.
 */
function moveAccountMemory(shared: string, account: string): void {
  const projects = path.join(account, "projects");
  let names: string[];
  try {
    names = readdirSync(projects);
  } catch {
    return;
  }
  for (const project of names) {
    const from = path.join(projects, project, "memory");
    const to = path.join(shared, "projects", project, "memory");
    let files: string[];
    try {
      files = readdirSync(from);
      if (files.length > 0) mkdirSync(to, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files) {
      const source = path.join(from, file);
      const target = path.join(to, file);
      try {
        if (!existsSync(target)) renameSync(source, target);
        else if (file === "MEMORY.md") {
          const present = readFileSync(target, "utf8");
          const known = new Set(present.split("\n").map((line) => line.trim()));
          const missing = readFileSync(source, "utf8")
            .split("\n")
            .filter((line) => line.trim() && !known.has(line.trim()));
          if (missing.length > 0) appendFileSync(target, `${present === "" || present.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
          unlinkSync(source);
        } else if (readFileSync(source).equals(readFileSync(target))) unlinkSync(source);
      } catch {
        // Left with the account, as a memory whose name the CLI login's folder already uses is.
      }
    }
    try {
      rmdirSync(from);
    } catch {
      // Still holds a memory that could not move.
    }
  }
}

export class ClaudeAccountService {
  private readonly logins = new Map<string, { process: ChildProcess; done: Promise<void> }>();
  private readonly startingLogins = new Map<string, Promise<{ started: boolean }>>();
  private readonly status = new Map<string, { at: number; value: Promise<Connection> }>();
  private readonly generations = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly snapshot: () => EnvSnapshot,
    private readonly changed: (credentialsChanged?: string) => void,
    private readonly busy: (id: string) => boolean,
    private readonly retireIdle: (id: string) => Promise<void> = async () => {},
  ) {}

  get hasPendingWork(): boolean {
    return this.logins.size > 0 || this.startingLogins.size > 0;
  }

  defaultId(): string {
    return claudeAccounts.defaultId(this.db);
  }

  require(id: string): ClaudeAccount {
    const account = claudeAccounts.get(this.db, id);
    if (!account.enabled) throw new Error(`The Claude account “${account.name}” is disabled. Enable it in Settings → Connections to continue this conversation.`);
    return account;
  }

  environment(snapshot: EnvSnapshot, id = this.defaultId()): EnvSnapshot {
    const account = this.require(id);
    if (this.signingIn(id)) throw new Error(`Finish signing in to “${account.name}” before starting a conversation.`);
    const env = { ...snapshot.env };
    if (account.kind === "managed") {
      const shared = claudeConfigDir(os.homedir(), env);
      for (const key of Object.keys(env)) if (inheritedAuth.test(key)) delete env[key];
      env["CLAUDE_CONFIG_DIR"] = this.directory(account);
      env[SHARED_CLAUDE_CONFIG_DIR] = shared;
      // Claude Code keeps auto-memory under this folder instead of the account's, naming each project's memory folder
      // the way it does for the CLI login, so every account reads and saves the same memories. autoMemoryDirectory
      // would need OpenOrc to repeat that naming, and Claude asks permission to use memory through a folder link.
      env["CLAUDE_CODE_REMOTE_MEMORY_DIR"] = shared;
      linkSharedSkills(shared, env["CLAUDE_CONFIG_DIR"]);
      moveAccountMemory(shared, env["CLAUDE_CONFIG_DIR"]);
    }
    return { ...snapshot, env: Object.freeze(env), claudeAccountId: id, scope: `${id}:${this.generations.get(id) ?? 0}` };
  }

  /** An unavailable Claude account must not hide the other installed providers. */
  inspectionEnvironment(snapshot: EnvSnapshot, id = this.defaultId()): EnvSnapshot {
    try {
      return this.environment(snapshot, id);
    } catch {
      return { ...snapshot, binaries: { ...snapshot.binaries, claude: null }, scope: `unavailable:${id}` };
    }
  }

  async list(refresh = false): Promise<ClaudeAccounts> {
    const snapshot = this.snapshot();
    if (refresh) {
      this.status.clear();
      for (const account of claudeAccounts.list(this.db)) this.generations.set(account.id, (this.generations.get(account.id) ?? 0) + 1);
    }
    const accounts = await Promise.all(claudeAccounts.list(this.db).map(async (account): Promise<ClaudeAccountConnection> => ({ ...account, ...(await this.connection(account, snapshot, refresh)) })));
    return { accounts, defaultId: this.defaultId() };
  }

  add(name: string): ClaudeAccount {
    const account = claudeAccounts.add(this.db, name);
    this.changed();
    return account;
  }

  update(input: { id: string; name?: string; enabled?: boolean; makeDefault?: true }): ClaudeAccount {
    if (input.enabled === false && (this.busy(input.id) || this.signingIn(input.id))) throw new Error("Finish this account's active sessions and sign-in before disabling it.");
    const account = claudeAccounts.update(this.db, input);
    this.invalidate(input.id);
    return account;
  }

  private signingIn(id: string): boolean {
    return this.logins.has(id) || this.startingLogins.has(id);
  }

  async login(id: string): Promise<{ started: boolean }> {
    if (this.signingIn(id)) return { started: false };
    const starting = this.startLogin(id).finally(() => this.startingLogins.delete(id));
    this.startingLogins.set(id, starting);
    return starting;
  }

  private async startLogin(id: string): Promise<{ started: boolean }> {
    if (this.closing) throw new Error("OpenOrc is closing.");
    const account = this.require(id);
    const snapshot = this.environment(this.snapshot(), id);
    const launch = captureLaunchEnvironment("claude", snapshot);
    const directory = snapshot.env["CLAUDE_CONFIG_DIR"] || path.join(os.homedir(), ".claude");
    await this.retireIdle(id);
    if (this.closing) throw new Error("OpenOrc is closing.");
    this.require(id);
    if (this.busy(id)) throw new Error("Finish this account's active sessions before signing in again.");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const command = launchCommand(launch.binary, ["--setting-sources", "user", "auth", "login", "--claudeai"]);
    const browser = account.kind === "managed" ? this.privateBrowser() : {};
    const process = spawn(command.file, command.args, { ...command.options, env: { ...launch.env, ...browser }, cwd: directory, stdio: "ignore", detached: globalThis.process.platform !== "win32" });
    this.errors.delete(id);
    const timer = setTimeout(() => stopProcess(process), 5 * 60_000);
    const done = new Promise<void>((resolve) => {
      process.once("error", () => this.errors.set(id, "Claude could not start sign-in. Check its installation and retry."));
      process.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !this.errors.has(id)) this.errors.set(id, "Sign-in did not finish. Retry and complete the browser sign-in.");
        this.logins.delete(id);
        this.invalidate(id, true);
        resolve();
      });
    });
    this.logins.set(id, { process, done });
    this.changed();
    return { started: true };
  }

  cancelLogin(id: string): { cancelled: boolean } {
    const pending = this.logins.get(id);
    if (pending) stopProcess(pending.process);
    return { cancelled: Boolean(pending) };
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.startingLogins.values()]);
    const pending = [...this.logins.values()];
    for (const login of pending) stopProcess(login.process);
    await Promise.all(pending.map((login) => login.done));
  }

  /** Added accounts sign in from Chrome Incognito so the browser's own Claude login stays put. Claude runs $BROWSER with the URL as its only argument, so a script adds the flags. */
  private privateBrowser(): Record<string, string> {
    const chrome = globalThis.process.platform === "win32" ? null : chromeExecutable();
    if (!chrome) return {};
    const script = path.join(this.dataDir, "claude-accounts", "open-chrome-incognito");
    writeFileSync(script, `#!/bin/sh\nexec "$OPENORC_CHROME" ${chromeIncognitoFlags.join(" ")} "$1"\n`, { mode: 0o700 });
    return { BROWSER: script, OPENORC_CHROME: chrome };
  }

  private directory(account: ClaudeAccount): string {
    return account.kind === "managed" ? path.join(this.dataDir, "claude-accounts", account.id) : this.snapshot().env["CLAUDE_CONFIG_DIR"] || path.join(os.homedir(), ".claude");
  }

  private invalidate(id: string, credentialsChanged = false): void {
    this.status.clear();
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.changed(credentialsChanged ? id : undefined);
  }

  private connection(account: ClaudeAccount, snapshot: EnvSnapshot, refresh: boolean): Promise<Connection> {
    if (!account.enabled) return Promise.resolve({ ...disconnected, status: "disabled" });
    if (this.signingIn(account.id)) return Promise.resolve({ ...disconnected, status: "signing_in", message: "Complete sign-in in your browser." });
    const key = `${account.id}:${snapshot.revision}`;
    const cached = this.status.get(key);
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = this.probe(account, snapshot);
    this.status.set(key, { at: Date.now(), value });
    return value;
  }

  private async probe(account: ClaudeAccount, snapshot: EnvSnapshot): Promise<Connection> {
    try {
      const launch = captureLaunchEnvironment("claude", this.environment(snapshot, account.id));
      const command = launchCommand(launch.binary, ["--setting-sources", "user", "auth", "status", "--json"]);
      const { stdout } = await promisify(execFile)(command.file, command.args, { ...command.options, env: { ...launch.env }, cwd: os.tmpdir(), timeout: 8000, maxBuffer: 64 * 1024 });
      const result = authStatus.parse(JSON.parse(stdout));
      return { status: result.loggedIn ? "ready" : "signed_out", email: result.email ?? null, organization: result.orgName ?? null, message: this.errors.get(account.id) ?? null };
    } catch {
      return {
        ...disconnected,
        status: snapshot.binaries.claude ? "signed_out" : "unavailable",
        message: this.errors.get(account.id) ?? "Check the Claude Code installation, then sign in or refresh.",
      };
    }
  }
}

export { DEFAULT_CLAUDE_ACCOUNT };
