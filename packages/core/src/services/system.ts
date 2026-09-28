import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { captureProcessEnvironment } from "@openorc/agents";
import { harnessIds, type HarnessId, type HarnessInfo, type SystemInfo } from "@openorc/protocol";
import type { EnvSnapshot, RefreshResult, ShellEnvironment } from "./shell-environment.js";

type CommandResult = { status: "ok"; output: string } | { status: "exit"; output: string } | { status: "failed"; output: string };

export type CommandProbe = (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;

/** How to ask an installed harness for its version and whether it is signed in. */
export interface HarnessProbe {
  versionArgs: readonly string[];
  authArgs: readonly string[];
  /** True or false from a recognised answer; null when the output says nothing either way. */
  authenticated(output: string): boolean | null;
}

export const harnessProbes: Record<HarnessId, HarnessProbe> = {
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
};

/** Runs a CLI and preserves output from known non-zero auth responses. */
const runCommand: CommandProbe = (binary, args, env) =>
  new Promise((resolve) => {
    const child = execFile(binary, [...args], { timeout: 8000, env: { ...env }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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

/** The file a bare command name resolves to on one immutable PATH. */
export async function resolveBinary(name: string, envPath = process.env["PATH"] ?? ""): Promise<string | null> {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through the admitted PATH.
    }
  }
  return null;
}

/** What agents and tools this machine has, derived from the environment that launches them. */
export class SystemService {
  private cache: { at: number; revision: number; info: SystemInfo } | null = null;
  private readonly inFlight = new Map<number, Promise<SystemInfo>>();

  constructor(
    private readonly dataDir: string,
    private readonly environment: Pick<ShellEnvironment, "current" | "refresh">,
    private readonly command: CommandProbe = runCommand,
    private readonly probes: Record<HarnessId, HarnessProbe> = harnessProbes,
  ) {}

  /** Cached for a minute per environment revision. Concurrent callers share provider probes. */
  async info(refresh = false): Promise<SystemInfo> {
    const result: RefreshResult = refresh ? await this.environment.refresh() : { ok: true, snapshot: this.environment.current() };
    if (!result.ok) return this.failedRefreshInfo(result.snapshot);
    return this.infoFor(result.snapshot, captureProcessEnvironment(result.snapshot));
  }

  /** Reads one explicit snapshot, used by admitted runs that must not drift across awaits. */
  infoFor(snapshot: EnvSnapshot, env: Readonly<NodeJS.ProcessEnv> = captureProcessEnvironment(snapshot)): Promise<SystemInfo> {
    if (this.cache?.revision === snapshot.revision && Date.now() - this.cache.at < 60_000) return Promise.resolve(this.cache.info);
    const pending = this.inFlight.get(snapshot.revision);
    if (pending) return pending;
    const next = this.probeAll(snapshot, env).finally(() => this.inFlight.delete(snapshot.revision));
    this.inFlight.set(snapshot.revision, next);
    return next;
  }

  private async probeAll(snapshot: EnvSnapshot, env: Readonly<NodeJS.ProcessEnv>): Promise<SystemInfo> {
    const harnesses = await Promise.all(harnessIds.map((id) => this.probeHarness(id, snapshot, env)));
    const ghPath = await resolveBinary("gh", snapshot.path);
    const info = this.systemInfo(harnesses, { installed: ghPath !== null, path: ghPath });
    this.cache = { at: Date.now(), revision: snapshot.revision, info };
    return info;
  }

  private async probeHarness(id: HarnessId, snapshot: EnvSnapshot, env: Readonly<NodeJS.ProcessEnv>): Promise<HarnessInfo> {
    const binary = snapshot.binaries[id];
    if (!binary) return { id, state: "not_found", path: null, version: null, revision: snapshot.revision };

    const probe = this.probes[id];
    const [version, auth] = await Promise.all([this.command(binary, probe.versionArgs, { ...env }), this.command(binary, probe.authArgs, { ...env })]);
    const loggedIn = probe.authenticated(auth.output);
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
    const previous = this.cache?.revision === snapshot.revision ? this.cache.info : null;
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
