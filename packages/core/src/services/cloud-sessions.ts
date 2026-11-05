import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceLocation } from "@openorc/cloud";
import { runs, type CloudProviderId, type Db } from "@openorc/db";
import type { Thread } from "@openorc/protocol";

/** Where Claude Code keeps a session: `<config>/projects/<the folder it ran in, every other character as ->/<id>.jsonl`. */
export function claudeSessionFile(configDir: string, cwd: string, sessionId: string): string {
  return path.posix.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** A folder as Claude Code names it on this host: by its real path, which its working directory reads as. */
const asClaudeSees = (folder: string): Promise<string> => realpath(folder).catch(() => folder);

/** Every folder a session ran in, as its lines record them: on the line itself for Claude, inside its payload for Codex. */
function sessionFolders(text: string): string[] {
  const folders = new Set<string>();
  for (const match of text.matchAll(/"cwd":\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const cwd = JSON.parse(`"${match[1]}"`) as string;
      if (cwd.length > 1) folders.add(cwd);
    } catch {
      // Part of a line the CLI was still writing.
    }
  }
  return [...folders];
}

/** Where Codex keeps a session: `sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl` under its folder. */
async function codexSessionOnMac(home: string, sessionId: string): Promise<string | null> {
  const root = path.join(home, "sessions");
  for (const year of (await readdir(root).catch(() => [] as string[])).sort().reverse())
    for (const month of (await readdir(path.join(root, year)).catch(() => [] as string[])).sort().reverse())
      for (const day of (await readdir(path.join(root, year, month)).catch(() => [] as string[])).sort().reverse()) {
        const name = (await readdir(path.join(root, year, month, day)).catch(() => [] as string[])).find((file) => file.endsWith(`-${sessionId}.jsonl`));
        if (name) return path.join(root, year, month, day, name);
      }
  return null;
}

/** The session with every folder it ran in named as `cwd`, so it resumes there as if it had always run there. */
export function sessionMovedTo(text: string, cwd: string): string {
  // Longest first, so a folder inside another is replaced whole.
  return sessionFolders(text)
    .filter((folder) => folder !== cwd)
    .sort((a, b) => b.length - a.length)
    .reduce((moved, folder) => moved.split(folder).join(cwd), text);
}

/** A Claude session on its way to another host, with every folder it ran in still the source's. */
export interface RelocatedSession {
  agent: "claude";
  accountId: string;
  sessionId: string;
  text: string;
}

export interface CloudSessionDeps {
  db: Db;
  /** The account's Claude folder on this Mac. */
  configDirectory(accountId: string): string;
  defaultAccountId(): string;
  /** What the account's agent gets in the sandbox; Claude keeps sessions in its CLAUDE_CONFIG_DIR when that is set. */
  agentEnvironment(provider: CloudProviderId, accountId: string): Promise<Record<string, string>>;
  /** Codex's folder in the sandbox; null when the sandbox uses this Mac's own. */
  codexHomeIn(location: WorkspaceLocation, provider: CloudProviderId): Promise<string | null>;
  /** Codex's folder on this Mac. */
  codexHomeOnMac(): string;
}

/**
 * A cloud conversation's Claude session, kept on both sides. It goes up when a sandbox gets the code, so a conversation
 * that moved to the cloud, or whose sandbox was replaced, carries on where it was. It comes back to the account's folder
 * on this Mac after every turn, where Claude would look for it in the worktree.
 */
export class CloudSessions {
  constructor(private readonly deps: CloudSessionDeps) {}

  /** The conversation's last Claude session and its account; null before its first Claude turn. */
  private latest(thread: Thread): { sessionId: string; accountId: string } | null {
    const accountId = thread.claudeAccountId ?? this.deps.defaultAccountId();
    const sessionId = runs.lastSession(this.deps.db, { threadId: thread.id }, "claude", null, accountId);
    return sessionId ? { sessionId, accountId } : null;
  }

  private async inSandbox(location: WorkspaceLocation, provider: CloudProviderId, accountId: string, sessionId: string): Promise<string> {
    const env = await this.deps.agentEnvironment(provider, accountId);
    let configDir = env["CLAUDE_CONFIG_DIR"];
    if (!configDir) {
      const home = await location.install.sandbox.exec("sh", ["-c", 'printf %s "$HOME"']);
      configDir = path.posix.join(home.stdout.toString("utf8").trim(), ".claude");
    }
    return claudeSessionFile(configDir, location.repo, sessionId);
  }

  /** The session's file on this Mac: where the worktree's Claude would keep it, or wherever else it ran here. */
  private async onMac(configDir: string, worktree: string, sessionId: string): Promise<string | null> {
    const expected = claudeSessionFile(configDir, await asClaudeSees(worktree), sessionId);
    if (await isFile(expected)) return expected;
    const projects = path.join(configDir, "projects");
    for (const folder of await readdir(projects).catch(() => [] as string[])) {
      const file = path.join(projects, folder, `${sessionId}.jsonl`);
      if (await isFile(file)) return file;
    }
    return null;
  }

  /** Gives the sandbox the conversation's session, when this Mac has one. */
  async send(thread: Thread, location: WorkspaceLocation, provider: CloudProviderId): Promise<void> {
    if (thread.agent === "codex") return this.sendCodex(thread, location, provider);
    const latest = this.latest(thread);
    if (!latest || !thread.worktreePath) return;
    const file = await this.onMac(this.deps.configDirectory(latest.accountId), thread.worktreePath, latest.sessionId);
    if (!file) return;
    const target = await this.inSandbox(location, provider, latest.accountId, latest.sessionId);
    await location.install.sandbox.writeFile(target, Buffer.from(sessionMovedTo(await readFile(file, "utf8"), location.repo)));
  }

  private async sendCodex(thread: Thread, location: WorkspaceLocation, provider: CloudProviderId): Promise<void> {
    const sessionId = runs.lastSession(this.deps.db, { threadId: thread.id }, "codex");
    const home = await this.deps.codexHomeIn(location, provider);
    if (!sessionId || !home) return;
    const macHome = this.deps.codexHomeOnMac();
    const file = await codexSessionOnMac(macHome, sessionId);
    if (!file) return;
    const target = path.posix.join(home, path.relative(macHome, file).split(path.sep).join("/"));
    await location.install.sandbox.writeFile(target, Buffer.from(sessionMovedTo(await readFile(file, "utf8"), location.repo)));
  }

  private async keepCodex(thread: Thread, location: WorkspaceLocation, provider: CloudProviderId): Promise<void> {
    const sessionId = runs.lastSession(this.deps.db, { threadId: thread.id }, "codex");
    const home = await this.deps.codexHomeIn(location, provider);
    if (!sessionId || !home || !thread.worktreePath) return;
    const { sandbox } = location.install;
    const found = await sandbox.exec("sh", ["-c", 'ls "$1"/sessions/*/*/*/rollout-*-"$2".jsonl 2>/dev/null | head -1', "sh", home, sessionId]);
    const file = found.stdout.toString("utf8").trim();
    const data = file ? await sandbox.readFile(file) : null;
    if (!data) return;
    const target = path.join(this.deps.codexHomeOnMac(), path.posix.relative(home, file));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, sessionMovedTo(data.toString("utf8"), thread.worktreePath), { mode: 0o600 });
  }

  /** The conversation's last Claude session as this host keeps it, for its relocation package; null before its first turn. */
  async export(thread: Thread): Promise<RelocatedSession | null> {
    const latest = thread.agent === "claude" ? this.latest(thread) : null;
    if (!latest || !thread.worktreePath) return null;
    const file = await this.onMac(this.deps.configDirectory(latest.accountId), thread.worktreePath, latest.sessionId);
    return file ? { agent: "claude", ...latest, text: await readFile(file, "utf8") } : null;
  }

  /** A relocated session, where Claude looks for it in the thread's worktree on this host. */
  async import(thread: Thread & { worktreePath: string }, session: RelocatedSession): Promise<void> {
    const cwd = await asClaudeSees(thread.worktreePath);
    const target = claudeSessionFile(this.deps.configDirectory(session.accountId), cwd, session.sessionId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, sessionMovedTo(session.text, cwd), { mode: 0o600 });
  }

  /** Brings the conversation's session from the sandbox to the account's folder on this Mac. */
  async keep(thread: Thread, location: WorkspaceLocation, provider: CloudProviderId): Promise<void> {
    if (thread.agent === "codex") return this.keepCodex(thread, location, provider);
    const latest = this.latest(thread);
    if (!latest || !thread.worktreePath) return;
    const data = await location.install.sandbox.readFile(await this.inSandbox(location, provider, latest.accountId, latest.sessionId));
    if (!data) return;
    const cwd = await asClaudeSees(thread.worktreePath);
    const target = claudeSessionFile(this.deps.configDirectory(latest.accountId), cwd, latest.sessionId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, sessionMovedTo(data.toString("utf8"), cwd), { mode: 0o600 });
  }
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}
