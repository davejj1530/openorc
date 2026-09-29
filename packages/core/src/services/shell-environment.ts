import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { harnessBinaryVariable, harnessIds, type HarnessId } from "@openorc/protocol";

/**
 * The environment agents launch with, owned by the process that launches them.
 *
 * An app opened from the Dock inherits a bare PATH; one opened from a terminal
 * inherits that terminal's. Neither is what the user sees in their own shell,
 * so the login shell is asked once at startup and again on every Rescan. The
 * answer is a revisioned, immutable snapshot: a run captures the current one
 * when it is admitted and keeps it, and the next admitted run sees the next
 * one. A refresh that fails keeps the last good snapshot in place, so a
 * timeout never turns a working Claude into "not found".
 */

/** Absolute paths of the harness binaries the login shell resolves, or null where it resolves nothing. */
export type HarnessBinaries = Record<HarnessId, string | null>;

/** One entry per registry harness, resolved the same way. */
function harnessBinaries(resolve: (id: HarnessId) => string | null): HarnessBinaries {
  return Object.fromEntries(harnessIds.map((id) => [id, resolve(id)])) as HarnessBinaries;
}

/**
 * One accepted environment, frozen. Revision 0 is the launcher's; every
 * successful probe publishes the next. A run that captured a snapshot keeps
 * exactly this object: later refreshes, and later writes to process.env,
 * cannot reach into it.
 */
export interface EnvSnapshot {
  readonly revision: number;
  /** The login shell that answered, or the inherited one before any probe. */
  readonly shell: string;
  /** PATH as the login shell built it, in front of whatever the launcher had. Equals `env.PATH`. */
  readonly path: string;
  /** Equals the `OPENORC_*_BIN` entries of `env`. */
  readonly binaries: Readonly<HarnessBinaries>;
  /** The complete environment an agent admitted at this revision inherits. A copy, not a view of process.env. */
  readonly env: Readonly<Record<string, string>>;
}

export type RefreshResult = { ok: true; snapshot: EnvSnapshot } | { ok: false; error: string; snapshot: EnvSnapshot };

/** What one login shell reported. */
export interface ShellProbeResult {
  path: string;
  binaries: HarnessBinaries;
}

/** Asks a login shell what it knows. Rejects when the shell fails, times out or prints no PATH. */
export type ShellProbe = (shell: string) => Promise<ShellProbeResult>;

const MARK = "@@openorc@@";
const PROBE_TIMEOUT_MS = 8000;

/** Printed by the shell after its profile ran. Each value sits behind a marker, so banners and greetings cannot shift it. */
export const probeScript = `printf '\\n${MARK}path=%s\\n${harnessIds.map((id) => `${MARK}${id}=%s\\n`).join("")}' "$PATH" ${harnessIds.map((id) => `"$(command -v ${id} 2>/dev/null)"`).join(" ")}`;

export function parseShellProbe(stdout: string): ShellProbeResult | null {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(MARK)) continue;
    const eq = line.indexOf("=");
    values.set(line.slice(MARK.length, eq), line.slice(eq + 1).trim());
  }
  const path = values.get("path") ?? "";
  if (!path) return null;
  const file = (value: string | undefined) => (value && value.startsWith("/") ? value : null);
  return { path, binaries: harnessBinaries((id) => file(values.get(id))) };
}

/**
 * The user's login shell as the account records it, so a `chsh` between two
 * Rescans is honoured. SHELL is only a fallback: it is inherited at launch and
 * never changes for the life of the process. Past both, macOS's default shell,
 * or /bin/sh elsewhere, which an empty account shell means and every Linux has.
 */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  let fromAccount: string | undefined;
  try {
    fromAccount = os.userInfo().shell ?? undefined;
  } catch {
    fromAccount = undefined;
  }
  return fromAccount || env["SHELL"] || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

/**
 * Runs the login shell the way a terminal would: from a bare environment, so
 * the profile builds PATH from scratch instead of keeping whatever order the
 * launcher had. That is the order the user sees in their terminal, and the
 * `claude` they get there is the one they logged in with.
 */
export const probeLoginShell: ShellProbe = async (shell) => {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env["HOME"] ?? "",
    USER: process.env["USER"] ?? "",
    LOGNAME: process.env["LOGNAME"] ?? process.env["USER"] ?? "",
    SHELL: shell,
    TERM: "xterm-256color",
    LANG: process.env["LANG"] ?? "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    DISABLE_AUTO_UPDATE: "true",
  };
  const { stdout } = await promisify(execFile)(shell, ["-ilc", probeScript], { timeout: PROBE_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 });
  const parsed = parseShellProbe(stdout);
  if (!parsed) throw new Error(`${shell} printed no PATH`);
  return parsed;
};

/** A probe that reports the inherited environment unchanged: for tests and for platforms without a login shell to ask. */
export function inheritedProbe(env: NodeJS.ProcessEnv = process.env): ShellProbe {
  return async () => ({ path: env["PATH"] ?? "", binaries: harnessBinaries((id) => env[harnessBinaryVariable(id)] || null) });
}

export interface ShellEnvironmentOptions {
  /** Defaults to the real login shell. Tests hand in a fake. */
  probe?: ShellProbe;
  /** Defaults to the account's login shell. */
  shell?: () => string;
  /** The mutable environment agents inherit. Defaults to this process's; tests hand in a plain object. */
  env?: NodeJS.ProcessEnv;
}

/** The launcher's PATH entries after the login shell's, deduplicated, so nothing the launcher could find is lost. */
export function mergePath(login: string, launcher: string): string {
  return [...new Set([...login.split(":"), ...launcher.split(":")])].filter(Boolean).join(":");
}

export class ShellEnvironment {
  private snapshot: EnvSnapshot;
  private inFlight: Promise<RefreshResult> | null = null;
  private readonly listeners = new Set<(snapshot: EnvSnapshot) => void>();
  private readonly probe: ShellProbe;
  private readonly shell: () => string;
  private readonly env: NodeJS.ProcessEnv;
  /** Captured before the first merge; every merge starts from here, never from a previous merge. */
  private readonly launcherPath: string;

  constructor(options: ShellEnvironmentOptions = {}) {
    this.env = options.env ?? process.env;
    this.probe = options.probe ?? (process.platform === "win32" ? inheritedProbe(this.env) : probeLoginShell);
    this.shell = options.shell ?? (() => loginShell(this.env));
    this.launcherPath = this.env["PATH"] ?? "";
    this.snapshot = freezeSnapshot(0, this.shell(), this.env);
  }

  /** The accepted snapshot. Capture it once at admission; do not read it again after an await. */
  current(): EnvSnapshot {
    return this.snapshot;
  }

  /**
   * One probe at a time. A Rescan requested while one is running joins it
   * rather than racing it, which is what keeps revisions monotonic without a
   * queue. The swap from the old snapshot to the new one is a single
   * synchronous assignment, so a launch admitted on this event loop sees
   * either all of the old environment or all of the new one.
   */
  refresh(): Promise<RefreshResult> {
    if (!this.inFlight) this.inFlight = this.attempt().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  /** Called with every accepted snapshot after the first. */
  onChange(listener: (snapshot: EnvSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async attempt(): Promise<RefreshResult> {
    const shell = this.shell();
    let probed: ShellProbeResult;
    try {
      probed = await this.probe(shell);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), snapshot: this.snapshot };
    }
    return { ok: true, snapshot: this.apply(shell, probed) };
  }

  /**
   * Publishes atomically: the environment agents inherit and the snapshot
   * runs capture change in the same tick, with no await between them. The
   * snapshot is a frozen copy taken after the writes, so it agrees with what
   * process.env said at that instant and never changes afterwards.
   */
  private apply(shell: string, probed: ShellProbeResult): EnvSnapshot {
    this.env["PATH"] = mergePath(probed.path, this.launcherPath);
    for (const id of harnessIds) setOrClear(this.env, harnessBinaryVariable(id), probed.binaries[id]);
    const snapshot = freezeSnapshot(this.snapshot.revision + 1, shell, this.env);
    this.snapshot = snapshot;
    this.notify(snapshot);
    return snapshot;
  }

  /** Listeners are best effort. The snapshot is already accepted; a listener that fails cannot un-accept it. */
  private notify(snapshot: EnvSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn(`[core] shell environment listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** A frozen copy of `env` as it stands, with PATH and the harness overrides read back from it so the fields cannot disagree. */
function freezeSnapshot(revision: number, shell: string, env: NodeJS.ProcessEnv): EnvSnapshot {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) copy[key] = value;
  }
  return Object.freeze({
    revision,
    shell,
    path: copy["PATH"] ?? "",
    binaries: Object.freeze(harnessBinaries((id) => copy[harnessBinaryVariable(id)] || null)),
    env: Object.freeze(copy),
  });
}

/** A binary the shell no longer finds must stop being found here too, or an uninstalled harness stays Ready. */
function setOrClear(env: NodeJS.ProcessEnv, key: string, value: string | null): void {
  if (value) env[key] = value;
  else delete env[key];
}
