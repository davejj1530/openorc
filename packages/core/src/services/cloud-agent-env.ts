import { SHARED_CLAUDE_CONFIG_DIR } from "@openorc/agents";
import type { CloudProviderId } from "@openorc/db";
import type { ClaudeAccountService } from "./claude-accounts.js";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import type { EnvSnapshot } from "./shell-environment.js";

/** The parts of an added account's environment that point Claude Code at its own login on this Mac. */
const MAC_LOGIN = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_REMOTE_MEMORY_DIR", SHARED_CLAUDE_CONFIG_DIR];

/** How a Claude account's agent signs in inside a sandbox, given the provider that runs it. */
export type CloudAgentEnvironment = (provider: CloudProviderId, accountId?: string | null) => Promise<Record<string, string>>;

/**
 * An account's agent signs in to a sandbox with the account's cloud token. A sandbox simulated on this Mac can use the
 * account's own login here instead; a real one cannot, so an account without a token cannot run there.
 */
export function cloudAgentEnvironment(deps: {
  accounts: Pick<ClaudeAccountService, "defaultId" | "require" | "environment">;
  tokens: Pick<ClaudeCloudTokens, "token">;
  snapshot: () => EnvSnapshot;
}): CloudAgentEnvironment {
  return async (provider, accountId) => {
    const id = accountId ?? deps.accounts.defaultId();
    const account = deps.accounts.require(id);
    const token = await deps.tokens.token(id);
    if (token) return { CLAUDE_CODE_OAUTH_TOKEN: token };
    if (provider === "local") {
      const env = deps.accounts.environment(deps.snapshot(), id).env;
      return Object.fromEntries(MAC_LOGIN.flatMap((key) => (env[key] ? [[key, env[key]]] : [])));
    }
    throw new Error(`“${account.name}” has no token for cloud threads. Create one in Settings → Cloud.`);
  };
}
