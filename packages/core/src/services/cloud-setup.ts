import os from "node:os";
import path from "node:path";
import type { VercelConnection } from "@openorc/cloud";
import type { Db, LedgerWriter } from "@openorc/db";
import type { OpenOrcOptions } from "../options.js";
import type { Logger } from "../transport.js";
import type { ClaudeAccountService } from "./claude-accounts.js";
import { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import { CloudBrain } from "./cloud-brain.js";
import { macGitHub, type SignInSources } from "./cloud-brain-signins.js";
import { savedPushKey } from "../remote/push/keys.js";
import { cloudAgentEnvironment } from "./cloud-agent-env.js";
import { CloudChecks } from "./cloud-check.js";
import { CloudCodex } from "./cloud-codex.js";
import { CloudHandoff } from "./cloud-handoff.js";
import { CodexBrowserSignIn, CodexCloudLogin } from "./codex-cloud-login.js";
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
import { ThreadRelocations } from "./relocations.js";
import { RelocationCoordinator } from "./relocation-coordinator.js";
import { brainChannel } from "./cloud-brain-channel.js";
import type { WorkspaceService } from "./workspace.js";

/** The cloud brain as this Mac keeps it, made with the Vercel connection the Mac's sandboxes use. */
function cloudBrain(
  db: Db,
  options: OpenOrcOptions,
  tokens: ClaudeCloudTokens,
  vercel: () => Promise<VercelConnection | null>,
  signIns: SignInSources,
  invalidate: (keys: string[]) => void,
): CloudBrain {
  return new CloudBrain({
    db,
    store: options.cloudBrainSecrets,
    tokens,
    vercel,
    signIns,
    bundle: options.cloudBrainBundle,
    // "cloud" too: the brain's region is where this Mac's sandboxes run unless another is chosen.
    changed: () => invalidate(["cloud-brain", "cloud"]),
    ...(options.cloudBrainMachine ? { open: options.cloudBrainMachine } : {}),
    ...(options.cloudBrainDoors ? { doors: options.cloudBrainDoors } : {}),
  });
}

/** What the cloud's parts are made from. */
export interface CloudInput {
  db: Db;
  ledger: LedgerWriter;
  options: OpenOrcOptions;
  accounts: ClaudeAccountService;
  environment: () => EnvSnapshot;
  /** Made after the cloud's parts, so they are reached when used. */
  runs: () => RunService;
  threads: () => ThreadService;
  workspaces: () => WorkspaceService;
  invalidate: (keys: string[]) => void;
  /** The cloud brain changed: set up, removed, woken. */
  brainChanged?: () => void;
  log: Logger;
}

/** The cloud's parts, made together: where sandboxes run, how agents sign in there, and the sandboxes themselves. */
export function createCloud(input: CloudInput): {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  codex: CodexCloudLogin;
  cloud: CloudWorkspaceService;
  checks: CloudChecks;
  sandboxes: CloudSandboxes;
  handoff: CloudHandoff;
  standby: CloudStandby;
  brain: CloudBrain;
  relocations: ThreadRelocations;
  /** Null on the brain itself, which never coordinates a move. */
  coordinator: RelocationCoordinator | null;
} {
  const { db, options, accounts, environment, invalidate, log } = input;
  const settings = new CloudSettings(options.cloudSecrets, { brainRegion: () => brain.region() });
  const sandboxes = cloudSandboxProviders({
    dataDir: options.dataDir,
    env: () => environment().env,
    credentials: options.cloudCredentials ?? (() => settings.credentials()),
    ...(options.cloudSandboxes ? { override: options.cloudSandboxes } : {}),
    cloudOnly: options.cloudOnly,
  });
  const signIn = {
    signInLaunch: (id: string) => accounts.signInLaunch(id),
    cloudTokenChanged: (id: string) => {
      accounts.cloudTokenChanged(id);
      brain.signInsChanged();
    },
  };
  const tokens = new ClaudeCloudTokens(options.claudeCloudSecrets, signIn, () => invalidate(["cloud"]), options.terminal);
  const codexDeps = { binary: () => environment().binaries.codex ?? null, env: () => environment().env, terminal: options.terminal ?? spawnWithPipes };
  // The brain's Codex sign-in is a separate one, never this Mac's cloud login.
  const signIns: SignInSources = {
    github: macGitHub(),
    push: () => savedPushKey(db, options.pushSecrets),
    codex: new CodexBrowserSignIn({ ...codexDeps, changed: () => invalidate(["cloud-brain"]) }),
  };
  const brain: CloudBrain = cloudBrain(db, options, tokens, options.cloudCredentials ?? (() => settings.credentials()), signIns, (keys) => [invalidate(keys), input.brainChanged?.()]);
  const agentEnvironment = cloudAgentEnvironment({ accounts, tokens, snapshot: environment });
  // On a cloud-only host the cloud login is the only one, so whether Codex is signed in changes with it.
  const codexLogin = new CodexCloudLogin(options.codexCloudSecrets, { ...codexDeps, changed: () => invalidate(options.cloudOnly ? ["cloud", "system", "models"] : ["cloud"]) });
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
  const { relocations, coordinator } = createRelocations({ input, sessions, cloud, runs, brain, changed });
  return { settings, tokens, codex: codexLogin, cloud, checks, sandboxes: list, handoff, standby, brain, relocations, coordinator };
}

/** Moving threads between this host and the other brain; the Mac alone coordinates. */
function createRelocations({
  input,
  sessions,
  cloud,
  runs,
  brain,
  changed,
}: {
  input: CloudInput;
  sessions: CloudSessions;
  cloud: CloudWorkspaceService;
  runs: CloudSandboxRuns & CloudStandbyDeps["runs"];
  brain: CloudBrain;
  changed: (threadId: string) => void;
}): { relocations: ThreadRelocations; coordinator: RelocationCoordinator | null } {
  const { db, options, log } = input;
  const relocations = new ThreadRelocations({
    db,
    dataDir: options.dataDir,
    ledger: input.ledger,
    sessions,
    threadPath: (thread, project) => input.workspaces().threadPath(thread, project),
    cloud,
    runs,
    changed,
    drain: () => input.threads().recoverQueue(),
    log,
  });
  if (options.cloudOnly) return { relocations, coordinator: null };
  const coordinator = new RelocationCoordinator({
    db,
    brain: options.brainChannel ?? brainChannel(brain),
    relocations,
    runs,
    toWorktree: (id) => input.threads().moveWorkspace(id, "worktree"),
    cloud,
    changed,
    log,
    ...options.relocationTiming,
  });
  return { relocations, coordinator };
}

export type { ClaudeCloudTokens, CloudBrain, CloudChecks, CloudHandoff, CloudSandboxes, CloudSettings, CloudStandby, CodexCloudLogin };
