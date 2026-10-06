import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "@openorc/protocol";
import { resolveBinary, type EnvSnapshot } from "./shell-environment.js";

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
export type UpdateRunner = (command: UpdateCommand, env: NodeJS.ProcessEnv) => Promise<string>;

/** No shell, sudo, downloaded scripts, or commands supplied by the renderer. */
export const runUpdateCommand: UpdateRunner = (command, env) =>
  new Promise((resolve, reject) => {
    let timedOut = false;
    let failed = false;
    let bytes = 0;
    let output = "";
    const child = spawn(command.binary, command.args, {
      env: { ...env, CI: "1", NONINTERACTIVE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" },
      cwd: os.homedir(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      command.args[0] === "root" ? 8000 : 180_000,
    );
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        failed = true;
        stop();
      } else if (stdout) output += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => {
      failed = true;
      stop();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Package manager output can contain registry credentials. Do not send it to the renderer or ledger.
      if (failed || timedOut || code !== 0) {
        stop();
        reject(
          new Error(
            timedOut
              ? "The update timed out. Check the installation in a terminal, then try again."
              : "The updater could not finish. Run the update in a terminal to inspect permissions or package-manager errors, then check again.",
          ),
        );
      } else resolve(output.trim());
    });
    child.stdin.end();
  });

const packages: Record<HarnessId, string> = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code", opencode: "opencode-ai" };
const registry = (id: HarnessId, channel = "latest") => `https://registry.npmjs.org/${packages[id]}/${channel}`;

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

  const brewMatch = /^(.*)\/(Caskroom|Cellar)\/(codex|claude-code(?:@latest)?|opencode)\//.exec(target);
  if (brewMatch) {
    const [, prefix, kind, name] = brewMatch;
    // Only known casks use the Homebrew API. A formula may belong to a third-party tap.
    if (kind !== "Caskroom" || id === "opencode" || (id === "codex" ? name !== "codex" : !name?.startsWith("claude-code")))
      return { ...manual, method: "Homebrew", message: `Update this installation with Homebrew, then check again.` };
    const brew = await resolveBinary("brew", `${prefix}/bin`);
    const cask = (verb: string): UpdateCommand | null => (brew ? { binary: brew, args: [verb, "--cask", name!] } : null);
    return {
      ...manual,
      method: "Homebrew",
      releaseUrl: `https://formulae.brew.sh/api/cask/${name}.json`,
      command: cask("upgrade"),
      repair: cask("reinstall"),
      message: brew ? null : "Homebrew could not be found. Update in a terminal, then check again.",
    };
  }

  // npm's actual global root must own this exact binary, excluding pnpm, bun and project-local installs.
  const npmRoot = target.slice(0, target.lastIndexOf(`/node_modules/${packages[id]}/`));
  if (npmRoot && target.includes(`/node_modules/${packages[id]}/`) && !/[\\/](?:\.pnpm|\.bun|\.yarn)[\\/]/.test(target)) {
    const npm = await resolveBinary("npm", snapshot.path);
    if (npm) {
      const root = await run({ binary: npm, args: ["root", "--global"] }, { ...snapshot.env });
      if ((await realpath(root).catch(() => root)) === `${npmRoot}/node_modules`) {
        // npm skips a platform package it failed to fetch and still exits 0; installing again restores it.
        const command = { binary: npm, args: ["install", "--global", `${packages[id]}@latest`] };
        return { ...manual, method: "npm", command, repair: command, message: null };
      }
    }
  }

  const home = snapshot.env["HOME"] ?? os.homedir();
  if (id === "claude" && target.startsWith(path.join(home, ".local/share/claude/versions") + path.sep) && binary === path.join(home, ".local/bin/claude")) {
    let channel = "latest";
    try {
      const config = JSON.parse(await readFile(path.join(snapshot.env["CLAUDE_CONFIG_DIR"] ?? path.join(home, ".claude"), "settings.json"), "utf8"));
      if (config.autoUpdatesChannel === "stable") channel = "stable";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ...manual, message: "Claude’s release channel could not be read. Use claude update in a terminal." };
    }
    return { ...manual, method: `Native · ${channel}`, releaseUrl: registry(id, channel), command: { binary, args: ["update"] }, message: null };
  }
  if (id === "opencode" && target === path.join(home, ".opencode/bin/opencode")) {
    return { ...manual, method: "Native", command: { binary, args: ["upgrade", "--method", "curl"] }, message: null };
  }
  return manual;
}

/** Strict release numbers prevent malformed metadata and prereleases from becoming update prompts. */
export function releaseVersion(value: string | null): string | null {
  const match = value?.match(/(?:^|\s|v)(\d+\.\d+\.\d+)(?![\w.+-])/);
  return match?.[1] ?? null;
}
export function newerRelease(latest: string, installed: string): boolean {
  const a = latest.split(".").map(Number),
    b = installed.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
export async function fetchAgentRelease(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" }, credentials: "omit" });
  if (!response.ok) throw new Error("The release service could not be reached. Try checking again later.");
  const data: unknown = await response.json();
  const raw = typeof data === "object" && data !== null && "version" in data ? data.version : null;
  const version = typeof raw === "string" ? releaseVersion(raw) : null;
  if (!version || raw !== version) throw new Error("The release service returned an unrecognized version. Try checking again later.");
  return version;
}
