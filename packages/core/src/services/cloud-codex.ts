import path from "node:path";
import type { AgentHome } from "@openorc/agents";
import type { CloudProviderId } from "@openorc/db";
import type { SystemInfo } from "@openorc/protocol";
import type { BrokeredHeader } from "@openorc/cloud";
import { held, OUTSIDE_THE_SANDBOX, type CloudSignIn, type TurnSignIn } from "./cloud-agents.js";
import { CODEX_FILE_STORE } from "./codex-cloud-login.js";

/** What the cloud needs from the Codex cloud login. */
export interface CodexCloudLoginSource {
  has(): Promise<boolean>;
  forSandbox(): Promise<string | null>;
  keep(auth: string): Promise<void>;
}

const NO_LOGIN = "Codex has no sign-in for the cloud. Sign in with ChatGPT or add an API key in Settings → Cloud.";

type CodexAuth = { OPENAI_API_KEY?: string | null; tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }; last_refresh?: string };

/**
 * A token in a JWT's shape keeps what Codex reads from it (the account, the plan, when it expires) and loses its
 * signature, so no server accepts it.
 */
function unsigned(token: string | undefined): string {
  const parts = token?.split(".") ?? [];
  return parts.length === 3 ? `${parts[0]}.${parts[1]}.${Buffer.from(OUTSIDE_THE_SANDBOX).toString("base64url")}` : OUTSIDE_THE_SANDBOX;
}

/**
 * Codex's login with every secret replaced, and the header that carries the real one: ChatGPT's access token on its
 * requests to chatgpt.com, or the API key on OpenAI's API. Marked as just refreshed, so Codex does not try to refresh
 * it there; this host refreshes the login and the next turn's header carries the new token. Null for a login of
 * another shape, which then travels as it is.
 */
export function brokeredCodexLogin(auth: string): { auth: string; header: BrokeredHeader } | null {
  const login = JSON.parse(auth) as CodexAuth;
  if (login.OPENAI_API_KEY)
    return { auth: JSON.stringify({ ...login, OPENAI_API_KEY: `sk-${OUTSIDE_THE_SANDBOX}` }), header: { domain: "api.openai.com", name: "authorization", value: `Bearer ${login.OPENAI_API_KEY}` } };
  const access = login.tokens?.access_token;
  if (!access) return null;
  const tokens = { ...login.tokens, access_token: unsigned(access), id_token: unsigned(login.tokens?.id_token), refresh_token: OUTSIDE_THE_SANDBOX };
  return {
    auth: JSON.stringify({ ...login, tokens, last_refresh: new Date().toISOString() }),
    header: { domain: "chatgpt.com", name: "authorization", value: `Bearer ${access}` },
  };
}

/** A login that holds stand-ins came from this host and carries nothing to keep. */
const standIn = (auth: string) => auth.includes(OUTSIDE_THE_SANDBOX);

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

  async prepare(home: () => Promise<AgentHome | null>, _provider: CloudProviderId, _who: unknown, brokered: boolean): Promise<TurnSignIn> {
    const codex = await home();
    if (!codex) return held({});
    const auth = await this.login?.forSandbox();
    if (!auth) throw new Error(NO_LOGIN);
    const outside = brokered ? brokeredCodexLogin(auth) : null;
    const folder = codex.env["CODEX_HOME"]!;
    await codex.write(path.posix.join(folder, "config.toml"), Buffer.from(CODEX_FILE_STORE));
    await codex.write(path.posix.join(folder, "auth.json"), Buffer.from(outside?.auth ?? auth));
    return { env: {}, headers: outside ? [outside.header] : [] };
  }

  async keep(home: () => Promise<AgentHome | null>): Promise<void> {
    const codex = this.login && (await home());
    if (!codex) return;
    const auth = (await codex.read(path.posix.join(codex.env["CODEX_HOME"]!, "auth.json")))?.toString("utf8");
    if (auth && !standIn(auth)) await this.login!.keep(auth);
  }
}

/** On a cloud-only host Codex signs in only with the cloud login, so a Codex found there counts as signed in while it has one. */
export function withCloudCodexLogin(info: SystemInfo, signedIn: boolean): SystemInfo {
  if (!signedIn) return info;
  return { ...info, harnesses: info.harnesses.map((row) => (row.id === "codex" && row.state === "sign_in" ? { ...row, state: "ready" } : row)) };
}
