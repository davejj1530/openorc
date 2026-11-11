import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harnessCatalog, type HarnessId } from "@openorc/protocol";
import { resolveBinary, type EnvSnapshot } from "./shell-environment.js";
import { homebrewInstallation, OMP_FORMULA } from "./agent-update-homebrew.js";

export interface UpdateCommand {
  binary: string;
  args: string[];
}
export interface AgentInstallation {
  method: string;
  releaseUrl: string;
  command: UpdateCommand | null;
  /** Restores an installation that no longer starts; null when the broken binary would have to repair itself. */
  repair: UpdateCommand | null;
  message: string | null;
  /** The resolved launcher must still identify the same installation at update time. */
  identity: string;
}
/** How long the `npm root --global` lookup may take. */
export const PROBE_LIMIT_MS = 8000;
/** Long enough for a release archive of a few hundred megabytes on a slow connection. */
export const INSTALL_LIMIT_MS = 30 * 60_000;

export type UpdateRunner = (command: UpdateCommand, env: NodeJS.ProcessEnv, options?: { limitMs?: number; signal?: AbortSignal }) => Promise<string>;

const ENDINGS = {
  timeout: `The update took longer than ${INSTALL_LIMIT_MS / 60_000} minutes and was stopped. Check your connection, then try again.`,
  stopped: "The update was stopped.",
  failed: "The updater could not finish. Run the update in a terminal to inspect permissions or package-manager errors, then check again.",
};

/** No shell, sudo, downloaded scripts, or commands supplied by the renderer. */
export const runUpdateCommand: UpdateRunner = (command, env, { limitMs = INSTALL_LIMIT_MS, signal } = {}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(ENDINGS.stopped));
      return;
    }
    let ending: keyof typeof ENDINGS | null = null;
    let bytes = 0;
    let output = "";
    const child = spawn(command.binary, command.args, {
      env: { ...env, CI: "1", NONINTERACTIVE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" },
      cwd: os.homedir(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const end = (how: keyof typeof ENDINGS) => {
      ending ??= how;
      kill();
    };
    const timer = setTimeout(() => end("timeout"), limitMs);
    const stopped = () => end("stopped");
    signal?.addEventListener("abort", stopped, { once: true });
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) end("failed");
      else if (stdout) output += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => end("failed"));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stopped);
      // Package manager output can contain registry credentials. Do not send it to the renderer or ledger.
      if (ending || code !== 0) {
        kill();
        reject(new Error(ENDINGS[ending ?? "failed"]));
      } else resolve(output.trim());
    });
    child.stdin.end();
  });

const npmPackage = (id: HarnessId) => harnessCatalog[id].cli.npm;
function registry(id: HarnessId, channel = "latest"): string {
  if (id === "fx") return "https://releases.fx.sh/latest.txt";
  if (id === "cursor") return "https://cursor.com/install";
  if (id === "antigravity") {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    return `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}_${arch}.json`;
  }
  return `https://registry.npmjs.org/${npmPackage(id)}/${channel}`;
}

/** Recognize only installations whose owner can be proved; wrappers/custom package managers stay manual. */
export async function detectAgentInstallation(id: HarnessId, binary: string, snapshot: EnvSnapshot, run: UpdateRunner = runUpdateCommand): Promise<AgentInstallation> {
  const target = await realpath(binary);
  const manual: AgentInstallation = {
    identity: target,
    method: "Manual",
    releaseUrl: registry(id),
    command: null,
    repair: null,
    message: "Update using the tool that installed this agent, then check again.",
  };
  if (process.platform === "win32") return manual;

  const brew = await homebrewInstallation(id, manual);
  if (brew) return brew;

  // npm's actual global root must own this exact binary, excluding pnpm, bun and project-local installs.
  const pkg = npmPackage(id);
  const npmRoot = pkg ? target.slice(0, target.lastIndexOf(`/node_modules/${pkg}/`)) : null;
  if (pkg && npmRoot && target.includes(`/node_modules/${pkg}/`) && !/[\\/](?:\.pnpm|\.bun|\.yarn)[\\/]/.test(target)) {
    const npm = await resolveBinary("npm", snapshot.path);
    if (npm) {
      const root = await run({ binary: npm, args: ["root", "--global"] }, { ...snapshot.env }, { limitMs: PROBE_LIMIT_MS });
      if ((await realpath(root).catch(() => root)) === `${npmRoot}/node_modules`) {
        // npm skips a platform package it failed to fetch and still exits 0; installing again restores it.
        const command = { binary: npm, args: ["install", "--global", `${pkg}@latest`] };
        return { ...manual, method: "npm", command, repair: command, message: null };
      }
    }
  }

  return detectNativeInstallation(id, binary, snapshot.env, manual);
}

async function detectNativeInstallation(id: HarnessId, binary: string, env: NodeJS.ProcessEnv, manual: AgentInstallation): Promise<AgentInstallation> {
  const detect = nativeInstallers[id];
  if (detect) return detect(binary, env, manual);
  const home = env["HOME"] ?? os.homedir();
  const target = manual.identity;
  if (ownsNativeVersion("cursor", id, binary, target, home)) {
    return { ...manual, method: "Native", command: { binary, args: ["update"] }, message: null };
  }
  if (ownsNativeVersion("claude", id, binary, target, home)) {
    let channel = "latest";
    try {
      const config = JSON.parse(await readFile(path.join(env["CLAUDE_CONFIG_DIR"] ?? path.join(home, ".claude"), "settings.json"), "utf8"));
      if (config.autoUpdatesChannel === "stable") channel = "stable";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ...manual, message: "Claude’s release channel could not be read. Use claude update in a terminal." };
    }
    // claude update reads this channel, which can trail npm by days.
    return { ...manual, method: `Native · ${channel}`, releaseUrl: `https://downloads.claude.ai/claude-code-releases/${channel}`, command: { binary, args: ["update"] }, message: null };
  }
  if (id === "opencode" && target === path.join(home, ".opencode/bin/opencode")) {
    return { ...manual, method: "Native", command: { binary, args: ["upgrade", "--method", "curl"] }, message: null };
  }
  // Oh My Pi's installer puts its prebuilt binary here, which `omp update` replaces in place.
  if (id === "omp" && target === path.join(env["PI_INSTALL_DIR"] || path.join(home, ".local/bin"), "omp")) {
    return { ...manual, method: "Native", command: { binary, args: ["update"] }, message: null };
  }
  return manual;
}

const nativeInstallers: Partial<Record<HarnessId, (binary: string, env: NodeJS.ProcessEnv, manual: AgentInstallation) => AgentInstallation | Promise<AgentInstallation>>> = {
  codex: detectStandaloneCodex,
  antigravity: detectAntigravity,
  fx: detectFx,
};

function detectAntigravity(binary: string, env: NodeJS.ProcessEnv, manual: AgentInstallation): AgentInstallation {
  const installed = path.join(env["HOME"] ?? os.homedir(), ".local/bin/agy");
  return binary === installed && manual.identity === binary ? { ...manual, method: "Native", command: { binary, args: ["update"] }, message: null } : manual;
}

async function detectFx(binary: string, env: NodeJS.ProcessEnv, manual: AgentInstallation): Promise<AgentInstallation> {
  const home = env["HOME"] || os.homedir();
  if (binary !== path.join(env["FX_INSTALL_DIR"] || path.join(home, ".local/bin"), "fx") || manual.identity !== binary) return manual;
  try {
    const config: unknown = JSON.parse(await readFile(path.join(env["FX_HOME"] || path.join(home, ".fx"), "settings.json"), "utf8"));
    if (config && typeof config === "object" && "update_channel" in config && config.update_channel !== "stable")
      return { ...manual, message: "fx uses a development release channel. Run fx upgrade in a terminal." };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return { ...manual, message: "fx's release channel could not be read. Run fx upgrade in a terminal." };
  }
  return { ...manual, method: "Native", command: { binary, args: ["upgrade"] }, message: null };
}

function ownsNativeVersion(expected: "claude" | "cursor", id: HarnessId, binary: string, target: string, home: string): boolean {
  const name = expected === "cursor" ? "cursor-agent" : "claude";
  return id === expected && target.startsWith(path.join(home, ".local/share", name, "versions") + path.sep) && binary === path.join(home, ".local/bin", name);
}

async function detectStandaloneCodex(binary: string, env: NodeJS.ProcessEnv, manual: AgentInstallation): Promise<AgentInstallation> {
  const home = env["HOME"] ?? os.homedir();
  if (binary !== path.join(env["CODEX_INSTALL_DIR"] || path.join(home, ".local/bin"), "codex")) return manual;
  const managed = ["NPM", "BUN", "PNPM", "VITE_PLUS"].some((manager) => env[`CODEX_MANAGED_BY_${manager}`] !== undefined);
  const installerMode = ["DAEMON_ONLY", "DEFER_SELECTION", "IF_LATEST", "IF_CURRENT"].some((mode) => env[`CODEX_INSTALL_${mode}`] === "1");
  const release = env["CODEX_RELEASE"];
  if (managed || installerMode || (release && release !== "latest")) return manual;
  const codexHome = await realpath(env["CODEX_HOME"] || path.join(home, ".codex")).catch(() => null);
  if (!codexHome) return manual;
  const standalone = path.join(codexHome, "packages/standalone");
  const current = path.join(standalone, "current/bin/codex");
  if (manual.identity.startsWith(path.join(standalone, "releases") + path.sep) && manual.identity === (await realpath(current).catch(() => null))) {
    return { ...manual, method: "Native", command: { binary, args: ["update"] }, message: null };
  }
  return manual;
}

/** Strict release numbers prevent malformed metadata and prereleases from becoming update prompts. */
export function releaseVersion(value: string | null): string | null {
  const cursor = value?.match(/(?:^|\s)(\d{4}\.\d{2}\.\d{2}-[a-f0-9]+)(?=\s|$)/);
  if (cursor) return cursor[1] ?? null;
  // Oh My Pi says "omp/18.18.1".
  const match = value?.match(/(?:^|[\s/]|v)(\d+\.\d+\.\d+)(?![\w.+-])/);
  return match?.[1] ?? null;
}
export function newerRelease(latest: string, installed: string): boolean {
  if (/^\d{4}\.\d{2}\.\d{2}-/.test(latest) && /^\d{4}\.\d{2}\.\d{2}-/.test(installed)) {
    return latest.slice(0, 10) > installed.slice(0, 10) || (latest.slice(0, 10) === installed.slice(0, 10) && latest !== installed);
  }
  const a = latest.split(".").map(Number),
    b = installed.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
export async function fetchAgentRelease(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" }, credentials: "omit" });
  if (!response.ok) throw new Error("The release service could not be reached. Try checking again later.");
  // npm and Homebrew answer with JSON metadata; Claude's native channel answers with a bare version.
  const body = (await response.text()).trim();
  if (url === OMP_FORMULA) {
    const version = /^\s*version "(\d+\.\d+\.\d+)"\s*$/m.exec(body)?.[1];
    if (!version) throw new Error("Oh My Pi's Homebrew formula did not identify its current release. Try checking again later.");
    return version;
  }
  if (url === "https://cursor.com/install") {
    const version = /https:\/\/downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[a-f0-9]+)\//.exec(body)?.[1];
    if (!version) throw new Error("Cursor's installer did not identify its current release. Run cursor-agent update in a terminal.");
    return version;
  }
  const data: unknown = body.startsWith("{") ? JSON.parse(body) : { version: url === "https://releases.fx.sh/latest.txt" ? body.replace(/^v/, "") : body };
  const raw = releaseField(data);
  const version = typeof raw === "string" ? releaseVersion(raw) : null;
  if (!version || raw !== version) throw new Error("The release service returned an unrecognized version. Try checking again later.");
  return version;
}

function releaseField(data: unknown): unknown {
  if (!data || typeof data !== "object") return null;
  if ("version" in data) return data.version;
  if ("versions" in data && data.versions && typeof data.versions === "object" && "stable" in data.versions) return data.versions.stable;
  return null;
}
