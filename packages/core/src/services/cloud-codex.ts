import path from "node:path";
import type { AgentHome } from "@openorc/agents";
import type { CloudProviderId } from "@openorc/db";
import type { SystemInfo } from "@openorc/protocol";
import type { CloudSignIn } from "./cloud-agents.js";
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
export class CodexCloudSignIn implements CloudSignIn {
  constructor(private readonly login: CodexCloudLoginSource | undefined) {}

  async assertCanRun(provider: CloudProviderId): Promise<void> {
    if (provider !== "local" && !(await this.login?.has())) throw new Error(NO_LOGIN);
  }

  async homeEnv(state: string, provider: CloudProviderId): Promise<Record<string, string> | null> {
    if (provider === "local" && !(await this.login?.has())) return null;
    return { CODEX_HOME: path.posix.join(state, "codex") };
  }

  async prepare(home: () => Promise<AgentHome | null>): Promise<Record<string, string>> {
    const codex = await home();
    if (!codex) return {};
    const auth = await this.login?.forSandbox();
    if (!auth) throw new Error(NO_LOGIN);
    const folder = codex.env["CODEX_HOME"]!;
    await codex.write(path.posix.join(folder, "config.toml"), Buffer.from(CODEX_FILE_STORE));
    await codex.write(path.posix.join(folder, "auth.json"), Buffer.from(auth));
    return {};
  }

  async keep(home: () => Promise<AgentHome | null>): Promise<void> {
    const codex = this.login && (await home());
    if (!codex) return;
    const auth = await codex.read(path.posix.join(codex.env["CODEX_HOME"]!, "auth.json"));
    if (auth) await this.login!.keep(auth.toString("utf8"));
  }
}

/** On a cloud-only host Codex signs in only with the cloud login, so a Codex found there counts as signed in while it has one. */
export function withCloudCodexLogin(info: SystemInfo, signedIn: boolean): SystemInfo {
  if (!signedIn) return info;
  return { ...info, harnesses: info.harnesses.map((row) => (row.id === "codex" && row.state === "sign_in" ? { ...row, state: "ready" } : row)) };
}
