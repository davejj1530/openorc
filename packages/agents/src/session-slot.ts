import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { SESSION_ID, type AgentEvent, type HarnessId, type PermissionPreset, type RunMode } from "@openorc/protocol";

/** A native session id that is a plain name, so it can name a file. */
export type SessionId = string & { readonly brand: "SessionId" };

/** Parsed once at every boundary; null for anything that is not a plain name. */
export function sessionId(value: unknown): SessionId | null {
  return typeof value === "string" && SESSION_ID.test(value) ? (value as SessionId) : null;
}

/** One agent's folders on one machine, and its CLI there. Paths are that machine's. Never holds credentials. */
export interface AgentHome {
  readonly agent: HarnessId;
  readonly machine: "here" | "sandbox";
  readonly userHome: string;
  /** Only the variables that point the CLI at its folders: CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_DATA_HOME. */
  readonly env: Readonly<Record<string, string>>;
  readonly binary: string;
  /** Null when the file does not exist. */
  read(file: string): Promise<Buffer | null>;
  /** Folders 0700, files 0600; on a host home written beside, then renamed. */
  write(file: string, bytes: Buffer): Promise<void>;
  remove(file: string): Promise<void>;
  /** The names in `dir`; with `recursive`, every file under it as a path relative to it. Empty when it is missing. */
  list(dir: string, options?: { recursive: true }): Promise<string[]>;
  realpath(file: string): Promise<string>;
  run(args: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: Buffer; stderr: string }>;
}

/** A host home (the Mac or the brain machine) can also start the CLI as a live JSON-RPC process, for `check`. */
export interface HostHome extends AgentHome {
  readonly machine: "here";
  spawn(args: readonly string[], options: { cwd: string }): ChildProcessWithoutNullStreams;
}

export interface SessionRef {
  sessionId: SessionId;
  /** The folder it runs in at that home, as the CLI sees it (real path). */
  cwd: string;
  /** Its subagents' native ids: Codex child threads, OpenCode child sessions, Claude agent ids. */
  children: readonly string[];
}

/** A saved conversation out of its home: exact bytes only its slot reads, and what wrote them. */
export interface SavedSession {
  agent: HarnessId;
  /** The slot's format; `import` refuses one it does not know. */
  format: number;
  /**
   * The CLI version that wrote it, as `version` reads it. Null between a host and its own sandbox, whose CLIs are kept
   * at one version.
   */
  cliVersion: string | null;
  sessionId: SessionId;
  /** In the order import needs them. Names are the slot's and checked by it before any write. */
  parts: readonly { name: string; bytes: Buffer }[];
  meta: Readonly<Record<string, string | number | boolean | null>>;
}

/** A saved session leaving its host in a package, stamped with the CLI version that wrote it. */
export type PackedSession = SavedSession & { cliVersion: string };

/** The session cannot go, in words a person reads. Nothing was written. */
export class SessionRefused extends Error {}

export interface RunSettings {
  model: string | null;
  effort: string | null;
  mode: RunMode;
  permissionMode: PermissionPreset;
}

export interface HeadlessRun {
  cmd: string;
  args: string[];
  /** What the run's process environment needs beyond the turn's own, given it. */
  env?: (base: Record<string, string>) => Record<string, string>;
  /** `end` closes a turn whose stream does not say so itself, given the process's exit. */
  parser: (runId: string) => { parseLine(line: string): AgentEvent[]; end?(code: number | null): AgentEvent[]; readonly turns: number };
}

export interface SessionSlot {
  readonly agent: HarnessId;
  readonly format: number;
  /** Why this agent's conversations stay on the machine they started on; null when they travel. */
  readonly stays: string | null;
  /** The CLI's version at `home`. */
  version(home: AgentHome): Promise<string>;
  /** Whether a CLI at version `reader` resumes what version `written` saved. */
  readable(written: string, reader: string): boolean;
  /** The whole saved conversation at `home`; null before its first turn. SessionRefused when it cannot leave whole. */
  export(home: AgentHome, ref: SessionRef): Promise<SavedSession | null>;
  /**
   * Puts it at `home` to resume from `cwd`, replacing any copy there. Idempotent. Checks every name first. Resolves with
   * the digest an export from `home` now reads, so no caller reads it back.
   */
  import(home: AgentHome, saved: SavedSession, cwd: string): Promise<string>;
  /** Proves the CLI at a host home resumes it from `cwd` with no model call; the reason when it cannot. */
  check(home: HostHome, ref: SessionRef): Promise<string | null>;
  /** Content digest, comparable only with another export from the same home. */
  digest(saved: SavedSession): string;
  /** The agent continuing it in one headless process (takeover), and the parser for its stdout. */
  continueOnce(ref: Pick<SessionRef, "sessionId">, prompt: string, settings: RunSettings): HeadlessRun;
}

/** sha256 over each part's name and bytes, in order. */
export function partsDigest(parts: SavedSession["parts"]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.name}\0${part.bytes.length}\0`).update(part.bytes);
  return hash.digest("hex");
}

/** The first x.y.z in a CLI's version line. */
export function releaseOf(output: string): string | null {
  const cursor = /(?:^|\s)(\d{4}\.\d{2}\.\d{2}-[a-f0-9]+)(?=\s|$)/.exec(output)?.[1];
  if (cursor) return cursor;
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Whether release `a` is at least `b`, by x.y.z. */
export function atLeast(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return (left[i] ?? 0) > (right[i] ?? 0);
  return true;
}

/** Reads the CLI's `--version` at a home, once per home. */
export function versionReader(): (home: AgentHome) => Promise<string> {
  const read = new WeakMap<AgentHome, Promise<string>>();
  return (home) => {
    const known = read.get(home);
    if (known) return known;
    const version = home.run(["--version"], { timeoutMs: 30_000 }).then(({ code, stdout, stderr }) => {
      const release = code === 0 ? releaseOf(stdout.toString("utf8")) : null;
      if (!release) throw new SessionRefused(`${home.binary} did not say its version: ${stderr.trim().slice(-200) || `exit ${code}`}`);
      return release;
    });
    read.set(home, version);
    version.catch(() => read.delete(home));
    return version;
  };
}
