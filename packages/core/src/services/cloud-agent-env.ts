import { SHARED_CLAUDE_CONFIG_DIR } from "@openorc/agents";
import type { CloudProviderId } from "@openorc/db";
import type { ClaudeAccountService } from "./claude-accounts.js";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import { held, OUTSIDE_THE_SANDBOX, type CloudRunWho, type CloudSignIn, type TurnSignIn } from "./cloud-agents.js";
import type { EnvSnapshot } from "./shell-environment.js";

/** Where Claude Code sends its token: Anthropic's API, and the proxy for the account's claude.ai connectors. */
const CLAUDE_HOSTS = ["api.anthropic.com", "mcp-proxy.anthropic.com"];

/** The parts of an added account's environment that point Claude Code at its own login on this Mac. */
const MAC_LOGIN = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_REMOTE_MEMORY_DIR", SHARED_CLAUDE_CONFIG_DIR];

/**
 * An account's agent signs in to a sandbox with the account's cloud token. A sandbox simulated on this Mac can use the
 * account's own login here instead; a real one cannot, so an account without a token cannot run there.
 */
export class ClaudeCloudSignIn implements CloudSignIn {
  constructor(
    private readonly deps: {
      accounts: Pick<ClaudeAccountService, "defaultId" | "require" | "environment">;
      tokens: Pick<ClaudeCloudTokens, "token">;
      snapshot: () => EnvSnapshot;
    },
  ) {}

  private async environment(provider: CloudProviderId, accountId: string | null): Promise<Record<string, string>> {
    const id = accountId ?? this.deps.accounts.defaultId();
    const account = this.deps.accounts.require(id);
    const token = await this.deps.tokens.token(id);
    if (token) return { CLAUDE_CODE_OAUTH_TOKEN: token };
    if (provider === "local") {
      const env = this.deps.accounts.environment(this.deps.snapshot(), id).env;
      return Object.fromEntries(MAC_LOGIN.flatMap((key) => (env[key] ? [[key, env[key]]] : [])));
    }
    throw new Error(`“${account.name}” has no token for cloud threads. Create one in Settings → Cloud.`);
  }

  async assertCanRun(provider: CloudProviderId, who: CloudRunWho): Promise<void> {
    await this.environment(provider, who.claudeAccountId);
  }

  async homeEnv(_state: string, provider: CloudProviderId, who: CloudRunWho): Promise<Record<string, string>> {
    const folder = (await this.environment(provider, who.claudeAccountId))["CLAUDE_CONFIG_DIR"];
    return folder ? { CLAUDE_CONFIG_DIR: folder } : {};
  }

  /**
   * Brokered, Claude Code holds a token in its own token's shape that signs in nowhere, and the firewall sets the
   * real one on its requests to Anthropic as Claude Code would.
   */
  async prepare(_home: unknown, provider: CloudProviderId, who: CloudRunWho, brokered: boolean): Promise<TurnSignIn> {
    const { CLAUDE_CONFIG_DIR: _folder, ...credentials } = await this.environment(provider, who.claudeAccountId);
    const token = credentials["CLAUDE_CODE_OAUTH_TOKEN"];
    if (!brokered || !token) return held(credentials);
    return {
      env: { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${OUTSIDE_THE_SANDBOX}` },
      headers: CLAUDE_HOSTS.map((domain) => ({ domain, name: "authorization", value: `Bearer ${token}` })),
    };
  }

  async keep(): Promise<void> {}
}
