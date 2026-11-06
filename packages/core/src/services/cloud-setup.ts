import type { Agent37Connection, AgentVersions, VercelConnection } from "@openorc/cloud";
import type { CloudService, HarnessId } from "@openorc/protocol";
import { claudeAccounts, type Db, type LedgerWriter } from "@openorc/db";
import type { OpenOrcOptions } from "../options.js";
import type { Logger } from "../transport.js";
import type { ClaudeAccountService } from "./claude-accounts.js";
import { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import { CloudBrain, type CloudBrainDeps } from "./cloud-brain.js";
import { BrainMove, MOVE_PHONES, type BrainMoveDeps } from "./cloud-brain-move.js";
import type { BrainRouting } from "./brain-routing.js";
import { rememberRemovedBrain } from "../remote/removed-brains.js";
import { machineOpener } from "./cloud-brain-machine.js";
import { macGitHub, macMemoryKey, type SignInSources } from "./cloud-brain-signins.js";
import type { MemoryService } from "./memory.js";
import { savedPushKey } from "../remote/push/keys.js";
import { ClaudeCloudSignIn } from "./cloud-agent-env.js";
import { cloudAgents, type CloudAgents } from "./cloud-agents.js";
import { CloudChecks } from "./cloud-check.js";
import { CodexCloudSignIn } from "./cloud-codex.js";
import { OpenCodeCloudKeys, OpenCodeCloudSignIn } from "./cloud-opencode.js";
import { CloudHandoff } from "./cloud-handoff.js";
import { CodexBrowserSignIn, CodexCloudLogin } from "./codex-cloud-login.js";
import { spawnWithPipes } from "./terminal-process.js";
import { CloudSandboxes, type BrainSandboxes, type CloudSandboxRuns } from "./cloud-sandboxes.js";
import { CloudSignInsFlow } from "./cloud-sign-ins.js";
import { macSignIns } from "./mac-agent-keys.js";
import { agentHomes, everyVersion, hostVersions } from "./agent-homes.js";
import { AgentSessions } from "./agent-sessions.js";
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

/** The connections cloud machines are made with, and the service new ones go to. */
interface CloudSources {
  vercel: () => Promise<VercelConnection | null>;
  agent37: () => Promise<Agent37Connection | null>;
  service: () => Promise<CloudService | null>;
}

/** The services Settings connects, unless the options name the connections, as tests and the brain's start line do. */
function cloudSources(options: OpenOrcOptions, settings: CloudSettings): CloudSources {
  if (!options.cloudCredentials && !options.cloudAgent37) return { vercel: () => settings.credentials(), agent37: () => settings.agent37(), service: () => settings.service() };
  const vercel = options.cloudCredentials ?? (async () => null);
  const agent37 = options.cloudAgent37 ?? (async () => null);
  const service = async (): Promise<CloudService | null> => {
    const chosen = await options.cloudService?.();
    if (chosen) return chosen;
    if (await vercel()) return "vercel";
    return (await agent37()) ? "agent37" : null;
  };
  return { vercel, agent37, service };
}

/**
 * The cloud brain as this Mac keeps it, made on the service and with the connection the Mac's sandboxes use, and a
 * maker of brains kept beside it in other records while it moves to the other service.
 */
function cloudBrain(
  db: Db,
  options: OpenOrcOptions,
  tokens: ClaudeCloudTokens,
  sources: CloudSources,
  signIns: SignInSources,
  invalidate: (keys: string[]) => void,
  agentVersions: () => Promise<AgentVersions>,
): { brain: CloudBrain; beside: BrainMoveDeps["beside"] } {
  // "cloud" too: the brain's region is where this Mac's sandboxes run unless another is chosen.
  const changed = () => invalidate(["cloud-brain", "cloud"]);
  const deps: CloudBrainDeps = {
    db,
    store: options.cloudBrainSecrets,
    tokens,
    ...sources,
    signIns,
    agentVersions,
    bundle: options.cloudBrainBundle,
    changed,
    open: options.cloudBrainMachine ?? machineOpener(options.cloudRunnerFiles),
    ...(options.cloudBrainUpdateWait ? { updateWait: options.cloudBrainUpdateWait } : {}),
    ...(options.cloudBrainDoors ? { doors: options.cloudBrainDoors } : {}),
  };
  return {
    brain: new CloudBrain(deps),
    // Settings shows a brain beside this one only through the move, which follows it with `also`.
    beside: (store, also) => new CloudBrain({ ...deps, store, phonesKey: MOVE_PHONES, changed: () => also?.() }),
  };
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
  /**
   * How this Mac's windows reach the cloud brain, made after the cloud's parts: it follows the brain as it changes, and
   * lists and lets go of a brain that moves. Null on the brain itself.
   */
  routing?: () => BrainRouting | null;
  /** Made after the cloud's parts, so it is reached when used. */
  memory: () => Pick<MemoryService, "choice" | "apiKey">;
  log: Logger;
}

/** Where sandboxes run. */
function sandboxServices(options: OpenOrcOptions, sources: CloudSources, env: () => NodeJS.ProcessEnv) {
  return cloudSandboxProviders({
    dataDir: options.dataDir,
    env,
    credentials: sources.vercel,
    agent37: sources.agent37,
    service: sources.service,
    ...(options.cloudRunnerFiles ? { files: options.cloudRunnerFiles } : {}),
    ...(options.cloudSandboxes ? { override: options.cloudSandboxes } : {}),
    cloudOnly: options.cloudOnly,
    simulated: options.cloudSimulated ?? true,
  });
}

/** The cloud's parts, made together: where sandboxes run, how agents sign in there, and the sandboxes themselves. */
export function createCloud(input: CloudInput): {
  settings: CloudSettings;
  tokens: ClaudeCloudTokens;
  codex: CodexCloudLogin;
  opencode: OpenCodeCloudKeys;
  cloud: CloudWorkspaceService;
  checks: CloudChecks;
  sandboxes: CloudSandboxes;
  handoff: CloudHandoff;
  standby: CloudStandby;
  brain: CloudBrain;
  signIns: CloudSignInsFlow;
  relocations: ThreadRelocations;
  /** Null on the brain itself, which never coordinates a move. */
  coordinator: RelocationCoordinator | null;
  /** Moves the brain to the other service; null on the brain itself, and without a store for the new one. */
  move: BrainMove | null;
} {
  const { db, options, accounts, environment, invalidate, log } = input;
  const settings = new CloudSettings(options.cloudSecrets, { brainRegion: () => brain.region() });
  const sources = cloudSources(options, settings);
  const sandboxes = sandboxServices(options, sources, () => environment().env);
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
    memory: () => macMemoryKey(input.memory()),
    opencode: () => opencode.all(),
    codex: new CodexBrowserSignIn({ ...codexDeps, changed: () => invalidate(["cloud-brain"]) }),
  };
  const { brain, beside } = cloudBrain(
    db,
    options,
    tokens,
    sources,
    signIns,
    (keys) => [invalidate(keys), void input.routing?.()?.refresh()],
    () => everyVersion(versions),
  );
  // On a cloud-only host the cloud login is the only one, so whether Codex is signed in changes with it.
  const codexLogin = new CodexCloudLogin(options.codexCloudSecrets, { ...codexDeps, changed: () => invalidate(options.cloudOnly ? ["cloud", "system", "models"] : ["cloud"]) });
  const opencode = new OpenCodeCloudKeys(options.opencodeCloudSecrets, () => {
    invalidate(["cloud"]);
    brain.signInsChanged();
  });
  const agents = cloudAgents({
    claude: new ClaudeCloudSignIn({ accounts, tokens, snapshot: environment }),
    codex: new CodexCloudSignIn(codexLogin),
    opencode: new OpenCodeCloudSignIn(opencode),
  });
  const { sessions, versions } = agentParts(input, agents);
  const changed = (id: string) => invalidate(["threads", `thread:${id}`]);
  const cloud = new CloudWorkspaceService(
    db,
    { ...sandboxes, agents, sessions, versions, changed, cloudOnly: options.cloudOnly, ...(options.cloudRunnerFiles ? { files: options.cloudRunnerFiles } : {}) },
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
  const list = new CloudSandboxes(db, cloud, runs, () => brainSandboxes(input.routing?.() ?? null));
  const handoff = new CloudHandoff({ db, cloud, runs, toWorktree: (id) => input.threads().moveWorkspace(id, "worktree"), changed, log });
  const standby = new CloudStandby({
    db,
    ledger: input.ledger,
    cloud,
    sessions,
    enabled: () => settings.takeover(),
    defaultAccountId: () => accounts.defaultId(),
    project: (thread) => executionProject(db, thread),
    runs,
    recordMessage: (id, message) => input.threads().recordMessage(id, message),
    invalidate,
    log,
  });
  // A thread's tasks move with it, so the task lists change too.
  const moved = (id: string) => invalidate(["threads", `thread:${id}`, "tasks", "inbox"]);
  const { relocations, coordinator } = createRelocations({ input, sessions, cloud, runs, brain, changed: moved });
  const flow = new CloudSignInsFlow({ db, tokens, codex: codexLogin, opencode, brain, mac: macSignIns(environment), changed: () => invalidate(["cloud-sign-ins"]) });
  const move = brainMove(input, { brain, beside, coordinator, connections: sources });
  return { settings, tokens, codex: codexLogin, opencode, cloud, checks, sandboxes: list, handoff, standby, brain, signIns: flow, relocations, coordinator, move };
}

/** The cloud brain's sandboxes, asked only while it is awake and linked: Settings never wakes it to list them. */
function brainSandboxes(routing: BrainRouting | null): BrainSandboxes | null {
  if (!routing?.active || routing.link.reach !== "live") return null;
  const { link } = routing;
  return {
    list: () => link.call("cloud.sandboxes", {}, { wake: false }),
    remove: async (name) => {
      await link.call("cloud.sandboxes.remove", { name }, { wake: false });
    },
  };
}

/** Moving the brain to the other service: the Mac's alone, given a store for the new brain's record. */
function brainMove(input: CloudInput, parts: Pick<BrainMoveDeps, "brain" | "beside" | "connections"> & { coordinator: RelocationCoordinator | null }): BrainMove | null {
  const { db, options, routing } = input;
  const { coordinator } = parts;
  const store = options.cloudBrainMoveSecrets;
  if (!coordinator || !store) return null;
  return new BrainMove({
    ...parts,
    db,
    store,
    coordinator,
    threads: async () => {
      const link = routing?.()?.link;
      if (!link) throw new Error("This Mac can't reach the cloud brain's threads.");
      // Archived ones too: they keep their history, and go with the brain that holds them.
      return link.call("threads.list", { filter: "all" }, { wake: true });
    },
    swapped: async (linkKey) => {
      if (linkKey) rememberRemovedBrain(db, linkKey);
      await routing?.()?.replaced();
    },
    changed: () => input.invalidate(["cloud-brain", "cloud"]),
  });
}

/** Where each agent keeps its conversations here and in sandboxes, the one caller that moves them, and this host's CLI versions. */
function agentParts(input: CloudInput, agents: CloudAgents): { sessions: AgentSessions; versions: (agent: HarnessId) => Promise<string | null> } {
  const { db, accounts, environment, options, log } = input;
  const homes = agentHomes({
    environment,
    claudeFolder: (id) => {
      const account = id ?? accounts.defaultId();
      return claudeAccounts.list(db).some((candidate) => candidate.id === account) ? accounts.configDirectory(account) : null;
    },
    agents,
  });
  return { sessions: new AgentSessions({ db, dataDir: options.dataDir, homes, log }), versions: hostVersions(homes) };
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
  sessions: AgentSessions;
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
