import type { Db } from "@openorc/db";
import type { OpenOrcOptions } from "../options.js";
import type { Logger } from "../transport.js";
import type { ClaudeAccountService } from "./claude-accounts.js";
import { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import { cloudAgentEnvironment } from "./cloud-agent-env.js";
import { CloudChecks } from "./cloud-check.js";
import { CloudSessions } from "./cloud-sessions.js";
import { CloudSettings } from "./cloud-settings.js";
import { CloudWorkspaceService, cloudSandboxProviders } from "./cloud-workspaces.js";
import type { EnvSnapshot } from "./shell-environment.js";

/** The cloud's parts, made together: where sandboxes run, how agents sign in there, and the sandboxes themselves. */
export function createCloud(input: { db: Db; options: OpenOrcOptions; accounts: ClaudeAccountService; environment: () => EnvSnapshot; invalidate: (keys: string[]) => void; log: Logger }): {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  cloud: CloudWorkspaceService;
  checks: CloudChecks;
} {
  const { db, options, accounts, environment, invalidate, log } = input;
  const settings = new CloudSettings(options.cloudSecrets);
  const sandboxes = cloudSandboxProviders({
    dataDir: options.dataDir,
    env: () => environment().env,
    credentials: options.cloudCredentials ?? (() => settings.credentials()),
    ...(options.cloudSandboxes ? { override: options.cloudSandboxes } : {}),
  });
  const tokens = new ClaudeCloudTokens(options.claudeCloudSecrets, accounts, () => invalidate(["cloud"]), options.terminal);
  const agentEnvironment = cloudAgentEnvironment({ accounts, tokens, snapshot: environment });
  const sessions = new CloudSessions({
    db,
    configDirectory: (id) => accounts.configDirectory(id),
    defaultAccountId: () => accounts.defaultId(),
    agentEnvironment: (provider, id) => agentEnvironment(provider, id),
  });
  const changed = (id: string) => invalidate(["threads", `thread:${id}`]);
  const cloud = new CloudWorkspaceService(db, { ...sandboxes, agentEnvironment, sessions, changed, ...(options.cloudRunnerFiles ? { files: options.cloudRunnerFiles } : {}) }, log);
  const checks = new CloudChecks(
    () => cloud.checkTarget(),
    () => invalidate(["cloud"]),
    log,
  );
  return { settings, tokens, cloud, checks };
}
