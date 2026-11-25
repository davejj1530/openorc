import { execFile } from "node:child_process";
import { captureProcessEnvironment, antigravityAuthenticated, cursorAuthenticated, piAuthenticated, fxAuthenticated, launchCommand } from "@openorc/agents";
import type { Db } from "@openorc/db";
import { hasGh } from "@openorc/git";
import { HarnessId, harnessIds, type HarnessInfo, type SystemInfo } from "@openorc/protocol";
import { z } from "zod";
import { keptAnswers, type Kept } from "./kept-answers.js";
import { resolveBinary, type EnvSnapshot, type RefreshResult, type ShellEnvironment } from "./shell-environment.js";

type CommandResult = { status: "ok"; output: string } | { status: "exit"; output: string } | { status: "failed"; output: string };

export type CommandProbe = (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;

/** How to ask an installed harness for its version and whether it is signed in. */
export interface HarnessProbe {
  versionArgs: readonly string[];
  authArgs: readonly string[];
  /** True or false from a recognised answer; null when the output says nothing either way. */
  authenticated(output: string, env?: Readonly<NodeJS.ProcessEnv>): boolean | null;
}

export const harnessProbes: Record<HarnessId, HarnessProbe> = {
  fx: { versionArgs: ["--version"], authArgs: ["status", "--json"], authenticated: fxAuthenticated },
  antigravity: { versionArgs: ["--version"], authArgs: ["models"], authenticated: antigravityAuthenticated },
  pi: { versionArgs: ["--version"], authArgs: ["--offline", "--list-models"], authenticated: piAuthenticated },
  cursor: {
    versionArgs: ["--version"],
    authArgs: ["status", "--format", "json"],
    authenticated: cursorAuthenticated,
  },
  codex: {
    versionArgs: ["--version"],
    authArgs: ["login", "status"],
    authenticated(output) {
      if (/not logged in|login required|sign[ -]?in required/i.test(output)) return false;
      return /logged in/i.test(output) ? true : null;
    },
  },
  claude: {
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    authenticated(output) {
      try {
        const json = /\{[\s\S]*\}/.exec(output)?.[0];
        if (!json) return null;
        const loggedIn = (JSON.parse(json) as { loggedIn?: unknown }).loggedIn;
        return typeof loggedIn === "boolean" ? loggedIn : null;
      } catch {
        return null;
      }
    },
  },
  opencode: {
    versionArgs: ["--version"],
    authArgs: ["auth", "list"],
    // `auth list` prints one row per saved provider credential; a bare header or nothing means no provider is signed in.
    authenticated(output) {
      if (/\bstored\b/i.test(output)) return true;
      return output.trim() === "" || /^(no |none)/i.test(output.trim()) ? false : null;
    },
  },
  omp: {
    versionArgs: ["--version"],
    authArgs: ["models", "--json"],
    // Oh My Pi lists only the models of providers it can reach: a saved login, an API key or cloud credentials.
    authenticated(output) {
      if (/"selector"\s*:/.test(output)) return true;
      return /"models"\s*:\s*\[\s*\]/.test(output) ? false : null;
    },
  },
};

/** Runs a CLI and preserves output from known non-zero auth responses. */
const runCommand: CommandProbe = (binary, args, env) =>
  new Promise((resolve) => {
    const command = launchCommand(binary, args);
    const child = execFile(command.file, command.args, { ...command.options, timeout: 8000, env: { ...env }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (!error) {
        resolve({ status: "ok", output });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      const failed = code === "ENOENT" || code === "EACCES" || error.killed;
      resolve({ status: failed ? "failed" : "exit", output });
    });
    child.stdin?.end();
  });

const KeptChecks: z.ZodType<SystemInfo> = z.object({
  dataDir: z.string(),
  harnesses: z.array(z.object({ id: HarnessId, state: z.enum(["ready", "sign_in", "not_found", "check_failed"]), path: z.string().nullable(), version: z.string().nullable(), revision: z.number() })),
  gh: z.object({ installed: z.boolean(), path: z.string().nullable() }),
});

/** The last checks, by the Claude account they were run for. */
export const keptChecks = (db: Db): Kept<SystemInfo> => keptAnswers(db, "system.last", KeptChecks);

interface Options {
  command?: CommandProbe;
  probes?: Record<HarnessId, HarnessProbe>;
  gh?: () => Promise<boolean>;
  /** Where the last checks outlive the app. */
  kept?: Kept<SystemInfo>;
  /** Checks a window had already been shown turned out different when run again. */
  changed?: () => void;
}

const cacheKey = (snapshot: EnvSnapshot) => `${snapshot.revision}:${snapshot.scope ?? ""}`;
/** Whose checks these are, whichever environment ran them. */
const checkedFor = (snapshot: EnvSnapshot) => snapshot.claudeAccountId ?? snapshot.scope ?? "";
const sameChecks = (a: SystemInfo, b: SystemInfo) =>
  a.gh.installed === b.gh.installed &&
  a.gh.path === b.gh.path &&
  a.harnesses.length === b.harnesses.length &&
  a.harnesses.every((row, index) => {
    const other = b.harnesses[index];
    return other?.id === row.id && other.state === row.state && other.path === row.path && other.version === row.version;
  });

/** What agents and tools this machine has, derived from the environment that launches them. */
export class SystemService {
  private readonly cache = new Map<string, { at: number; info: SystemInfo }>();
  private readonly inFlight = new Map<string, Promise<SystemInfo>>();
  /** The latest checks per account, from any environment. */
  private readonly last = new Map<string, SystemInfo>();
  /** What `shown` answered from `last` while these checks ran, by cache key. */
  private readonly shownEarly = new Map<string, SystemInfo>();
  private ghAnswer: { at: number; installed: Promise<boolean> } | null = null;
  private readonly command: CommandProbe;
  private readonly probes: Record<HarnessId, HarnessProbe>;
  private readonly ghProbe: () => Promise<boolean>;

  constructor(
    private readonly dataDir: string,
    private readonly environment: Pick<ShellEnvironment, "current" | "refresh">,
    private readonly options: Options = {},
  ) {
    this.command = options.command ?? runCommand;
    this.probes = options.probes ?? harnessProbes;
    this.ghProbe = options.gh ?? hasGh;
  }

  /** Whether gh runs, asked at most every 30 s. Unlike `info`, nothing about the Mac's paths or harnesses. */
  async gh(): Promise<{ installed: boolean }> {
    if (!this.ghAnswer || Date.now() - this.ghAnswer.at >= 30_000) this.ghAnswer = { at: Date.now(), installed: this.ghProbe() };
    return { installed: await this.ghAnswer.installed };
  }

  /** Cached for a minute per environment revision. Concurrent callers share provider probes. */
  async info(refresh = false): Promise<SystemInfo> {
    const result: RefreshResult = refresh ? await this.environment.refresh() : { ok: true, snapshot: this.environment.current() };
    if (!result.ok) return this.failedRefreshInfo(result.snapshot);
    return this.infoFor(result.snapshot, captureProcessEnvironment(result.snapshot));
  }

  /** Reads one explicit snapshot, used by admitted runs that must not drift across awaits. */
  infoFor(snapshot: EnvSnapshot, env: Readonly<NodeJS.ProcessEnv> = captureProcessEnvironment(snapshot)): Promise<SystemInfo> {
    const key = cacheKey(snapshot);
    for (const [storedKey, value] of this.cache) if (Date.now() - value.at >= 60_000) this.cache.delete(storedKey);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached.info);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const next = this.probeAll(snapshot, env).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, next);
    return next;
  }

  /**
   * What windows show: the last checks of the same binaries at once, however old, run again behind the answer. Whoever
   * decides a launch from the checks reads `infoFor`, which waits for current ones.
   */
  shown(snapshot: EnvSnapshot, env: Readonly<NodeJS.ProcessEnv> = captureProcessEnvironment(snapshot)): Promise<SystemInfo> {
    const key = cacheKey(snapshot);
    const current = this.infoFor(snapshot, env);
    // `infoFor` has dropped what is past its minute, so checks still cached are current.
    const early = this.cache.has(key) ? undefined : this.lastFor(snapshot);
    if (!early) return current;
    this.shownEarly.set(key, early);
    current.catch(() => this.shownEarly.delete(key));
    return Promise.resolve(early);
  }

  /** The last checks stand only for the binaries they were about: a harness installed, moved or removed since is checked first. */
  private lastFor(snapshot: EnvSnapshot): SystemInfo | undefined {
    const name = checkedFor(snapshot);
    const last = this.last.get(name) ?? this.options.kept?.read(name);
    if (!last || last.harnesses.length !== harnessIds.length || !harnessIds.every((id, index) => last.harnesses[index]?.id === id && last.harnesses[index]?.path === snapshot.binaries[id])) {
      return undefined;
    }
    return this.systemInfo(
      last.harnesses.map((row) => ({ ...row, revision: snapshot.revision })),
      last.gh,
    );
  }

  private remember(snapshot: EnvSnapshot, info: SystemInfo): void {
    const name = checkedFor(snapshot);
    const before = this.last.get(name) ?? this.options.kept?.read(name);
    this.last.set(name, info);
    if (!before || !sameChecks(before, info)) this.options.kept?.write(name, info);
    const key = cacheKey(snapshot);
    const early = this.shownEarly.get(key);
    this.shownEarly.delete(key);
    if (early && !sameChecks(early, info)) this.options.changed?.();
  }

  private async probeAll(snapshot: EnvSnapshot, env: Readonly<NodeJS.ProcessEnv>): Promise<SystemInfo> {
    const harnesses = await Promise.all(harnessIds.map((id) => this.probeHarness(id, snapshot, env)));
    const ghPath = await resolveBinary("gh", snapshot.path);
    const info = this.systemInfo(harnesses, { installed: ghPath !== null, path: ghPath });
    this.cache.set(cacheKey(snapshot), { at: Date.now(), info });
    this.remember(snapshot, info);
    return info;
  }

  private async probeHarness(id: HarnessId, snapshot: EnvSnapshot, env: Readonly<NodeJS.ProcessEnv>): Promise<HarnessInfo> {
    const binary = snapshot.binaries[id];
    if (!binary) return { id, state: "not_found", path: null, version: null, revision: snapshot.revision };

    const probe = this.probes[id];
    const [version, auth] = await Promise.all([this.command(binary, probe.versionArgs, { ...env }), this.command(binary, probe.authArgs, { ...env })]);
    const loggedIn = probe.authenticated(auth.output, env);
    const state = harnessReadiness(version.status !== "ok" || auth.status === "failed", loggedIn);
    return {
      id,
      state,
      path: binary,
      version: version.status === "ok" ? version.output || null : null,
      revision: snapshot.revision,
    };
  }

  /** A failed login-shell refresh is not proof that either installed harness disappeared. */
  private failedRefreshInfo(snapshot: EnvSnapshot): SystemInfo {
    const previous = this.cache.get(cacheKey(snapshot))?.info;
    const harnesses = harnessIds.map((id): HarnessInfo => {
      const known = previous?.harnesses.find((row) => row.id === id);
      return {
        id,
        state: "check_failed",
        path: snapshot.binaries[id],
        version: known?.version ?? null,
        revision: snapshot.revision,
      };
    });
    return this.systemInfo(harnesses, previous?.gh ?? { installed: false, path: null });
  }

  private systemInfo(harnesses: HarnessInfo[], gh: SystemInfo["gh"]): SystemInfo {
    return { dataDir: this.dataDir, harnesses, gh };
  }
}

function harnessReadiness(probeFailed: boolean, loggedIn: boolean | null): HarnessInfo["state"] {
  if (probeFailed || loggedIn === null) return "check_failed";
  return loggedIn ? "ready" : "sign_in";
}
