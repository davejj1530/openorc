import path from "node:path";
import type { Sandbox, WorkspaceLocation } from "@openorc/cloud";
import type { CloudProviderId } from "@openorc/db";
import type { SystemInfo } from "@openorc/protocol";
import { CODEX_FILE_STORE } from "./codex-cloud-login.js";

/** What the cloud needs from the Codex cloud login. */
export interface CodexCloudLoginSource {
  has(): Promise<boolean>;
  forSandbox(): Promise<string | null>;
  keep(auth: string): Promise<void>;
}

const NO_LOGIN = "Codex has no sign-in for the cloud. Sign in with ChatGPT or add an API key in Settings → Cloud.";

/**
 * Codex in a cloud sandbox. It keeps its login and sessions in a folder of OpenOrc's own there, given the cloud login
 * before each turn and handing it back after, in case Codex refreshed it. A sandbox simulated on this Mac without a
 * cloud login uses this Mac's own Codex folder instead, as a turn here would.
 */
export class CloudCodex {
  constructor(private readonly login: CodexCloudLoginSource | undefined) {}

  /** Refuses before anything is made when Codex cannot sign in where the conversation would run. */
  async assertCanRun(provider: CloudProviderId): Promise<void> {
    if (provider !== "local" && !(await this.login?.has())) throw new Error(NO_LOGIN);
  }

  /** Codex's folder in the sandbox; null when it uses this Mac's own. */
  async home(location: WorkspaceLocation, provider: CloudProviderId): Promise<string | null> {
    if (provider === "local" && !(await this.login?.has())) return null;
    return path.posix.join(location.install.state, "codex");
  }

  /** Puts Codex and its login in place for a turn, and returns what its process needs to find them. */
  async prepare(location: WorkspaceLocation, provider: CloudProviderId): Promise<Record<string, string>> {
    const { sandbox } = location.install;
    await ensureCodex(sandbox, provider);
    const home = await this.home(location, provider);
    if (!home) return {};
    const auth = await this.login?.forSandbox();
    if (!auth) throw new Error(NO_LOGIN);
    await sandbox.writeFile(path.posix.join(home, "config.toml"), Buffer.from(CODEX_FILE_STORE));
    await sandbox.writeFile(path.posix.join(home, "auth.json"), Buffer.from(auth));
    return { CODEX_HOME: home };
  }

  /** After a turn: a login Codex refreshed in the sandbox comes back, so the next sandbox gets the live one. */
  async keep(location: WorkspaceLocation, provider: CloudProviderId): Promise<void> {
    const home = await this.home(location, provider);
    if (!home || !this.login) return;
    const auth = await location.install.sandbox.readFile(path.posix.join(home, "auth.json"));
    if (auth) await this.login.keep(auth.toString("utf8"));
  }
}

/** On a cloud-only host Codex signs in only with the cloud login, so a Codex found there counts as signed in while it has one. */
export function withCloudCodexLogin(info: SystemInfo, signedIn: boolean): SystemInfo {
  if (!signedIn) return info;
  return { ...info, harnesses: info.harnesses.map((row) => (row.id === "codex" && row.state === "sign_in" ? { ...row, state: "ready" } : row)) };
}

/** Codex on the sandbox's PATH, installed when missing. Never on a sandbox simulated on this Mac: that is the Mac's own. */
async function ensureCodex(sandbox: Sandbox, provider: CloudProviderId): Promise<void> {
  if ((await sandbox.exec("sh", ["-c", "command -v codex"])).code === 0) return;
  if (provider === "local") throw new Error("Codex is not installed on this Mac, where this sandbox is simulated.");
  const install = await sandbox.exec("npm", ["install", "-g", "@openai/codex"], { sudo: true });
  if (install.code !== 0) throw new Error(`Codex could not be installed in the cloud workspace: ${install.stderr.trim().slice(-500)}`);
}
