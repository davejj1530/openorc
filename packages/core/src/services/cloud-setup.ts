import os from "node:os";
import path from "node:path";
import type { Db, LedgerWriter } from "@openorc/db";
import type { OpenOrcOptions } from "../options.js";
import type { Logger } from "../transport.js";
import type { ClaudeAccountService } from "./claude-accounts.js";
import { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import { cloudAgentEnvironment } from "./cloud-agent-env.js";
import { CloudChecks } from "./cloud-check.js";
import { CloudCodex } from "./cloud-codex.js";
import { CloudHandoff } from "./cloud-handoff.js";
import { CodexCloudLogin } from "./codex-cloud-login.js";
import { spawnWithPipes } from "./terminal-process.js";
import { CloudSandboxes, type CloudSandboxRuns } from "./cloud-sandboxes.js";
import { CloudSessions } from "./cloud-sessions.js";
import { CloudStandby, type CloudStandbyDeps } from "./cloud-standby.js";
import { CloudSettings } from "./cloud-settings.js";
import { CloudWorkspaceService, cloudSandboxProviders } from "./cloud-workspaces.js";
import type { RunService } from "./runs.js";
import type { EnvSnapshot } from "./shell-environment.js";
import type { ThreadService } from "./threads.js";
import { executionProject } from "./workspace-home.js";

/** The cloud's parts, made together: where sandboxes run, how agents sign in there, and the sandboxes themselves. */
export function createCloud(input: {
  db: Db;
  ledger: LedgerWriter;
  options: OpenOrcOptions;
  accounts: ClaudeAccountService;
  environment: () => EnvSnapshot;
  /** Made after the cloud's parts, so they are reached when used. */
  runs: () => RunService;
  threads: () => ThreadService;
  invalidate: (keys: string[]) => void;
  log: Logger;
}): {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  codex: CodexCloudLogin;
  cloud: CloudWorkspaceService;
  checks: CloudChecks;
  sandboxes: CloudSandboxes;
  handoff: CloudHandoff;
  standby: CloudStandby;
} {
  const { db, options, accounts, environment, invalidate, log } = input;
  const settings = new CloudSettings(options.cloudSecrets);
  const sandboxes = cloudSandboxProviders({
    dataDir: options.dataDir,
    env: () => environment().env,
    credentials: options.cloudCredentials ?? (() => settings.credentials()),
    ...(options.cloudSandboxes ? { override: options.cloudSandboxes } : {}),
    cloudOnly: options.cloudOnly,
  });
  const tokens = new ClaudeCloudTokens(options.claudeCloudSecrets, accounts, () => invalidate(["cloud"]), options.terminal);
  const agentEnvironment = cloudAgentEnvironment({ accounts, tokens, snapshot: environment });
  const codexLogin = new CodexCloudLogin(options.codexCloudSecrets, {
    binary: () => environment().binaries.codex ?? null,
    env: () => environment().env,
    terminal: options.terminal ?? spawnWithPipes,
    changed: () => invalidate(["cloud"]),
  });
  const codex = new CloudCodex(codexLogin);
  const sessions = new CloudSessions({
    db,
    configDirectory: (id) => accounts.configDirectory(id),
    defaultAccountId: () => accounts.defaultId(),
    agentEnvironment: (provider, id) => agentEnvironment(provider, id),
    codexHomeIn: (location, provider) => codex.home(location, provider),
    codexHomeOnMac: () => environment().env["CODEX_HOME"] || path.join(os.homedir(), ".codex"),
  });
  const changed = (id: string) => invalidate(["threads", `thread:${id}`]);
  const cloud = new CloudWorkspaceService(
    db,
    { ...sandboxes, agentEnvironment, sessions, codex, changed, cloudOnly: options.cloudOnly, ...(options.cloudRunnerFiles ? { files: options.cloudRunnerFiles } : {}) },
    log,
  );
  const checks = new CloudChecks(
    () => cloud.checkTarget(),
    () => invalidate(["cloud"]),
    log,
  );
  const runs: CloudSandboxRuns & CloudStandbyDeps["runs"] = {
    threadActivity: (id) => input.runs().threadActivity(id),
    liveRunForThread: (id) => input.runs().liveRunForThread(id),
    closeAndWait: (id) => input.runs().closeAndWait(id),
    interrupt: (id) => input.runs().interrupt(id),
  };
  const list = new CloudSandboxes(db, cloud, runs);
  const handoff = new CloudHandoff({ db, cloud, runs, toWorktree: (id) => input.threads().moveWorkspace(id, "worktree"), changed, log });
  const standby = new CloudStandby({
    db,
    ledger: input.ledger,
    cloud,
    sessions,
    enabled: () => settings.takeover(),
    agentEnvironment: (provider, id) => agentEnvironment(provider, id),
    defaultAccountId: () => accounts.defaultId(),
    project: (thread) => executionProject(db, thread),
    runs,
    recordMessage: (id, message) => input.threads().recordMessage(id, message),
    invalidate,
    log,
  });
  return { settings, tokens, codex: codexLogin, cloud, checks, sandboxes: list, handoff, standby };
}

export type { ClaudeCloudTokens, CloudChecks, CloudHandoff, CloudSandboxes, CloudSettings, CloudStandby, CodexCloudLogin };
