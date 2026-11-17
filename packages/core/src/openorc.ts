import { captureLaunchEnvironment, claudeConfigDir, recoverAgentProcesses } from "@openorc/agents";
import { claudeAccounts as storedClaudeAccounts, cloudMoves as moveJournal, Db, LedgerWriter, plans, redact, settings as storedSettings } from "@openorc/db";
import type { Hosted, HostedThreads, OwnSkills } from "@openorc/hosted";
import { startMcpServer, type OpenOrcMcpServer } from "@openorc/mcp";
import {
  computerNames,
  harnessAvailability,
  harnessInfo,
  harnessLoggedIn,
  rpcParams,
  type CloudSessionGrant,
  type CloudSessionOwner,
  type HarnessId,
  type RpcMethod,
  type RpcRequest,
} from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { busyReason, fenceForUpdate, type BusyReason } from "./activity.js";
import { BenchGenerator } from "./bench.js";
import { DeviceService } from "./devices/service.js";
import { FrameCoalescer } from "./frames.js";
import { createHostedHandlers } from "./handlers/hosted.js";
import { TeamChatOrclingCalls } from "./services/team-chat-orclings.js";
import { hostedFilesFor, type HostedFiles } from "./services/hosted-files.js";
import { hostedParityHandlers } from "./handlers/hosted-parity.js";
import { threadCollaborationHandlers } from "./handlers/thread-collaboration.js";
import { createAccountPersonHandlers } from "./handlers/account-person.js";
import { createAttachmentsHandlers } from "./handlers/attachments.js";
import { createBenchHandlers } from "./handlers/bench.js";
import { createCatalogHandlers } from "./handlers/catalog.js";
import { createClaudeAccountHandlers } from "./handlers/claude-accounts.js";
import { createConnectorHandlers } from "./handlers/connectors.js";
import { ConnectorService, type ConnectorPlaces } from "./services/connectors.js";
import { accountFor } from "./services/openorc-account.js";
import { HostedSkills } from "./services/hosted-skills.js";
import { createHostedSkillsCloudHandlers } from "./handlers/hosted-skills-cloud.js";
import { createMacProjectsHandlers } from "./handlers/mac-projects.js";
import { MacProjects } from "./services/mac-projects.js";
import { createCloudMovesHandlers } from "./handlers/cloud-moves.js";
import { CloudCopies } from "./services/cloud-copies.js";
import { CloudMoves } from "./services/cloud-moves.js";
import { AgentSessions } from "./services/agent-sessions.js";
import { agentHomes } from "./services/agent-homes.js";
import { PlaceRouter } from "@openorc/hosted/router";
import { rememberedConnectors } from "./services/remembered-connectors.js";
import { createCloudHandlers } from "./handlers/cloud.js";
import { createCodeExplanationHandlers } from "./handlers/code-explanations.js";
import { createDeviceHandlers } from "./handlers/devices.js";
import { invalidParamsMessage, rpcLogLine } from "./handlers/diagnostics.js";
import { createEventsHandlers } from "./handlers/events.js";
import { createFilesHandlers } from "./handlers/files.js";
import { createSkillsHandlers } from "./handlers/skills.js";
import { createInboxHandlers } from "./handlers/inbox.js";
import { createInstructionsHandlers } from "./handlers/instructions.js";
import { createMcpAppsHandlers } from "./handlers/mcp-apps.js";
import { createMemoryHandlers } from "./handlers/memory.js";
import { createOrclingHandlers } from "./handlers/orclings.js";
import { createPreviewHandlers } from "./handlers/preview.js";
import { createProjectsHandlers } from "./handlers/projects.js";
import { createPullRequestHandlers } from "./handlers/pull-requests.js";
import { createRemoteHandlers } from "./handlers/remote.js";
import { createReviewCommentsHandlers } from "./handlers/review-comments.js";
import { createReviewThreadHandlers } from "./handlers/review-thread.js";
import { createReviewWorkspaceHandlers } from "./handlers/review-workspace.js";
import { createReviewerAppHandlers } from "./handlers/reviewer-app.js";
import { createRunsHandlers } from "./handlers/runs.js";
import { createSchedulesHandlers } from "./handlers/schedules.js";
import { createSettingsHandlers } from "./handlers/settings.js";
import { createSlackHandlers } from "./handlers/slack.js";
import { createSystemHandlers } from "./handlers/system.js";
import { createUsageHandlers } from "./handlers/usage.js";
import { createTaskCreateHandlers } from "./handlers/task-create.js";
import { createTaskDeleteHandlers } from "./handlers/task-delete.js";
import { createTaskQueriesHandlers } from "./handlers/task-queries.js";
import { createTaskUpdateHandlers } from "./handlers/task-update.js";
import { createThreadLaunchHandlers } from "./handlers/thread-launch.js";
import { createThreadMessagesHandlers } from "./handlers/thread-messages.js";
import { createThreadQueriesHandlers } from "./handlers/thread-queries.js";
import { createThreadWorkspaceHandlers } from "./handlers/thread-workspace.js";
import { composeHandlers, type Handlers } from "./handlers/types.js";
import { createWorkspaceHandlers } from "./handlers/workspace.js";
import { createWorktreeHandlers } from "./handlers/worktrees.js";
import { createBrowserHost } from "./mcp-host/browser.js";
import { createContextHost } from "./mcp-host/context.js";
import { createDeviceHost } from "./mcp-host/device.js";
import { createMemoryHost } from "./mcp-host/memory.js";
import { createOrclingHost } from "./mcp-host/orcling.js";
import { createRunHost } from "./mcp-host/run.js";
import { createTaskCreateHost } from "./mcp-host/task-create.js";
import { createTasksHost } from "./mcp-host/tasks.js";
import { OnlineTaskTools } from "./services/online-task-tools.js";
import { createThreadsHost } from "./mcp-host/threads.js";
import type { OpenOrcOptions } from "./options.js";
import { phoneCloudPlace } from "./remote/cloud-policy.js";
import { NO_CLOUD_SESSION, RemoteAccess } from "./remote/remote-access.js";
import { requestOrigin, type RequestOrigin } from "./request-origin.js";
import { guardContext } from "./remote/policy.js";
import { AgentUpdateService } from "./services/agent-updates.js";
import { AttachmentService } from "./services/attachments.js";
import { ClaudeAccountSwitch } from "./services/claude-account-switch.js";
import { ClaudeSignInRetry } from "./services/claude-sign-in-retry.js";
import { ClaudeAccountService } from "./services/claude-accounts.js";
import { claudeRunAccount } from "./services/claude-run-account.js";
import { createFileService } from "./services/file-service-setup.js";
import type { FileService } from "./services/files.js";
import { ImportService } from "./services/imports.js";
import { LedgerUpkeep } from "./services/ledger-upkeep.js";
import { LifecycleService } from "./services/lifecycle.js";
import { MemoryService, type ProviderInfo } from "./services/memory.js";
import { OrclingService } from "./services/orclings.js";
import { removeOwnCloud } from "./services/own-cloud-cleanup.js";
import { readPlanLimits } from "./services/plan-limits.js";
import { invalidateOnLifecycle } from "./services/preview.js";
import { ProjectService } from "./services/projects.js";
import { ProviderLog } from "./services/provider-log.js";
import { ProviderUsageService } from "./services/provider-usage.js";
import { PullRequestService } from "./services/pull-requests.js";
import { inUnvettedCopy } from "./services/review-copies.js";
import { ReviewService } from "./services/review.js";
import { ReviewerAppService } from "./services/reviewer-app.js";
import { RunService, type Notification, type RunHooks } from "./services/runs.js";
import { ScheduleService } from "./services/schedules.js";
import { OrclingWakeService } from "./services/orcling-wakes.js";
import { AppSettingsService } from "./services/settings.js";
import { ShellEnvironment, inheritedProbe, type EnvSnapshot } from "./services/shell-environment.js";
import { SlackService } from "./services/slack/service.js";
import { SystemService } from "./services/system.js";
import { TaskCheckoutService } from "./services/task-checkout.js";
import { TaskCommentService } from "./services/task-comments.js";
import { TextGenerationService } from "./services/text-generation.js";
import { ThreadService } from "./services/threads.js";
import { ToolImageStore } from "./services/tool-images.js";
import { ensureWorkspaceHome } from "./services/workspace-home.js";
import { WorkspaceWriters } from "./services/workspace-writers.js";
import { WorktreeCleanup } from "./services/worktree-cleanup.js";
import { WorkspaceService } from "./services/workspace.js";
import { transportLogger, type Logger, type RpcReply } from "./transport.js";

/**
 * The application core. One instance per app, living in the utility process.
 * The renderer talks to it only through `handle`, so every capability is a
 * validated method and every push is a typed message.
 */
/** Where each agent answers about connectors: Codex, OpenCode, Oh My Pi and every enabled Claude account. */
function connectorPlaces(db: Db, environment: () => EnvSnapshot, accounts: ClaudeAccountService): ConnectorPlaces {
  return {
    claudeAccounts: () =>
      storedClaudeAccounts.list(db).flatMap((account) => {
        if (!account.enabled) return [];
        try {
          return [{ id: account.id, name: account.name, launch: captureLaunchEnvironment("claude", accounts.environment(environment(), account.id)) }];
        } catch {
          return [];
        }
      }),
    claudeLogin: () => captureLaunchEnvironment("claude", environment()),
    codex: () => captureLaunchEnvironment("codex", environment()),
    opencode: () => captureLaunchEnvironment("opencode", environment()),
    omp: () => captureLaunchEnvironment("omp", environment()),
    cursor: () => captureLaunchEnvironment("cursor", environment()),
    pi: () => captureLaunchEnvironment("pi", environment()),
    antigravity: () => captureLaunchEnvironment("antigravity", environment()),
    fx: () => captureLaunchEnvironment("fx", environment()),
  };
}

export class OpenOrc {
  readonly slack: SlackService;
  readonly db: Db;
  readonly ledger: LedgerWriter;
  private readonly providerLog: ProviderLog;
  private readonly upkeep: LedgerUpkeep;
  private readonly toolImages: ToolImageStore;
  readonly frames: FrameCoalescer;
  readonly projects: ProjectService;
  readonly workspaces: WorkspaceService;
  private hosted: Hosted | null | undefined;
  private placeRouter: PlaceRouter | undefined;
  private phonePlaceRouter: PlaceRouter | undefined;
  private phonePlace: HostedThreads | undefined;
  readonly runs: RunService;
  readonly comments: TaskCommentService;
  readonly review: ReviewService;
  readonly taskCheckout: TaskCheckoutService;
  readonly system: SystemService;
  readonly agentUpdates: AgentUpdateService;
  /** The environment agents launch with. Runs capture `current()` at admission; Rescan calls `refresh()`. */
  readonly claudeAccounts: ClaudeAccountService;
  private connectorService: ConnectorService | null = null;
  private cloudMoveService: CloudMoves | null = null;
  private cloudCopyService: CloudCopies | null = null;
  readonly environment: ShellEnvironment;
  readonly providerUsage: ProviderUsageService;
  private readonly claudeAccountSwitch: ClaudeAccountSwitch;
  private readonly claudeSignInRetry: ClaudeSignInRetry;
  readonly memory: MemoryService;
  readonly orclings: OrclingService;
  readonly textGeneration: TextGenerationService;
  readonly threads: ThreadService;
  readonly settings: AppSettingsService;
  readonly lifecycle: LifecycleService;
  readonly pullRequests: PullRequestService;
  readonly reviewerApp: ReviewerAppService;
  readonly schedules: ScheduleService;
  readonly orclingWakes: OrclingWakeService;
  readonly files: FileService;
  readonly hostedFiles: HostedFiles;
  /** The person's own skills as their cloud turns get them, once the account exists. */
  private hostedSkills: HostedSkills | null = null;
  readonly imports: ImportService;
  readonly devices: DeviceService;
  readonly workspaceWriters = new WorkspaceWriters();
  private readonly log: Logger;
  private readonly bench: BenchGenerator;
  /** Phone access. Its listener runs once the host attaches its request path. */
  readonly remote: RemoteAccess;
  private readonly options: OpenOrcOptions;
  /** The windows alone, before the phone tap. */
  private readonly windows: OpenOrcOptions["transport"];
  /** What the account sends: to the windows, and of it to phones only what `publishCloud` passes to a session that shares cloud threads. */
  private readonly accountTransport: OpenOrcOptions["transport"] = {
    push: (message) => {
      this.windows.push(message);
      this.remote.publishCloud(message);
    },
  };
  private closingForUpdate = false;
  private mcp: Promise<OpenOrcMcpServer> | null = null;
  private readonly handlers: Handlers;

  private constructor(options: OpenOrcOptions, db: Db) {
    // Phones hear what the windows hear, through this one tap.
    const host = options.transport;
    this.windows = host;
    this.options = options = {
      ...options,
      transport: {
        push: (message) => {
          host.push(message);
          this.remote?.publish(message);
        },
      },
    };
    this.db = db;
    this.log = transportLogger(options.transport);
    this.providerLog = new ProviderLog(path.join(options.dataDir, "logs", "provider"));
    this.toolImages = new ToolImageStore(options.dataDir);
    this.ledger = new LedgerWriter(db, { native: (ev) => this.providerLog.write(ev) });
    this.upkeep = new LedgerUpkeep(db, { log: this.log, toolImages: this.toolImages });
    this.frames = new FrameCoalescer((frame) => options.transport.push({ type: "frame", frame }));
    this.bench = new BenchGenerator((ev) => this.frames.push(ev));
    const invalidate = (keys: string[]) => options.transport.push({ type: "invalidate", keys });
    this.remote = new RemoteAccess({
      db,
      dataDir: options.dataDir,
      ledger: this.ledger,
      secrets: options.remoteSecrets,
      log: this.log,
      invalidate,
      network: options.remoteNetwork,
      pushSecrets: options.pushSecrets,
      presence: options.presence,
      preview: options.preview,
      cloudSession: { owner: () => this.cloudOwner(), grant: (input) => this.cloudGrant(input) },
    });
    this.settings = new AppSettingsService(db);
    this.environment = new ShellEnvironment({ probe: options.shellProbe ?? (options.ephemeral ? inheritedProbe() : undefined), ...(options.shellEnv ? { env: options.shellEnv } : {}) });
    this.devices = new DeviceService({ db, dataDir: options.dataDir, environment: () => this.environment.current(), transport: options.transport, log: this.log, system: options.deviceSystem });
    this.system = new SystemService(options.dataDir, this.environment);
    this.claudeAccounts = new ClaudeAccountService(
      db,
      options.dataDir,
      () => this.environment.current(),
      (id) => {
        if (id) this.providerUsage?.forgetClaudeAccount(id);
        invalidate(["claude-accounts", "system", "models", "provider-usage"]);
      },
      (id) => Boolean(this.runs?.agentUpdating("claude") || this.memory?.hasPendingWork || this.textGeneration?.hasPendingWork || this.runs?.hasClaudeSessions(id)),
      (id) => this.runs.retireIdleClaudeSessions(id),
    );
    this.agentUpdates = new AgentUpdateService({
      info: (refresh) => this.system.info(refresh),
      environment: () => this.environment.current(),
      reserve: (id) => this.runs.reserveAgentUpdate(id),
      changed: () => invalidate(["agent-updates"]),
      refreshed: () => invalidate(["system", "models"]),
      read: (key) => storedSettings.get(db, key),
      write: (key, value) => storedSettings.set(db, key, value),
    });
    // The renderer decides whether the thread is already on screen.
    const notify = (n: Omit<Notification, "type">) => this.notify(n);
    this.projects = new ProjectService(db);
    this.workspaces = new WorkspaceService(db, { dataDir: options.dataDir }, this.log, this.workspaceWriters);
    const backgroundProviders = this.backgroundProviders();
    this.memory = new MemoryService(db, { dataDir: options.dataDir, secrets: options.memorySecrets, embedder: options.embedder }, backgroundProviders, invalidate, this.log);
    this.textGeneration = new TextGenerationService(db, backgroundProviders, invalidate);
    this.orclings = new OrclingService({ db, dataDir: options.dataDir, memory: this.memory, runs: () => this.runs, threads: () => this.threads, invalidate, log: this.log });
    this.memory.extractionOwner = (run, thread) => this.orclings.memoryOwner(run, thread);
    this.runs = new RunService(db, this.ledger, this.frames, () => this.mcpServer(), invalidate, this.log, this.runHooks(notify), undefined, this.workspaceWriters);
    this.threads = new ThreadService(
      db,
      this.runs,
      this.workspaces,
      invalidate,
      this.log,
      (exchange, agent, accountId) => this.textGeneration.title(exchange, agent, accountId),
      this.workspaceWriters,
      (id) => this.previewGone(id),
      (id) => claudeConfigDir(undefined, this.claudeAccounts.environment(this.environment.current(), id).env),
    );
    this.comments = new TaskCommentService(db, this.runs, this.threads, invalidate, options.dataDir);
    this.taskCheckout = new TaskCheckoutService(db, this.workspaceWriters, options.dataDir);
    this.review = new ReviewService(db, this.workspaceWriters, { dataDir: options.dataDir, conversations: this.threads });
    this.providerUsage = new ProviderUsageService(db, this.system, { apiKey: () => this.memory.credentialStatus(), cloud: async () => (await this.account?.account.agentUsage()) ?? [] }, (id) =>
      id ? this.claudeAccounts.environment(this.environment.current(), id) : this.environment.current(),
    );
    this.claudeAccountSwitch = new ClaudeAccountSwitch({ db, settings: this.settings, usage: this.providerUsage, runs: this.runs, threads: this.threads, log: this.log });
    this.claudeSignInRetry = new ClaudeSignInRetry({ db, accounts: this.claudeAccounts, runs: this.runs, threads: this.threads, log: this.log });
    this.lifecycle = new LifecycleService(db, invalidate, this.log);
    const updating = (agent: string) => this.runs.agentUpdating(agent);
    this.schedules = new ScheduleService(db, this.threads, invalidate, notify, this.log, { updating });
    this.orclingWakes = new OrclingWakeService({ db, activity: (id) => this.runs.threadActivity(id), threads: this.threads, log: this.log, updating });
    this.files = createFileService({ options, writers: this.workspaceWriters, invalidate, environment: () => this.environment.current() });
    this.imports = new ImportService(db, this.ledger, invalidate, this.log, this.toolImages);
    this.reviewerApp = new ReviewerAppService(db, { secrets: options.githubSecrets, invalidate });
    this.pullRequests = new PullRequestService(db, {
      dataDir: options.dataDir,
      system: this.system,
      threads: this.threads,
      runs: this.runs,
      reviewerApp: this.reviewerApp,
      writers: this.workspaceWriters,
      cloudProject: (projectId) => this.account?.threads?.project(projectId) ?? null,
      cloudReviews: () => this.account?.pullReviews ?? null,
      invalidate,
    });
    this.slack = new SlackService(this, options.slackSecrets, new AttachmentService(options.dataDir));
    this.hostedFiles = hostedFilesFor(options, () => this.account, this.windows);
    this.handlers = this.buildHandlers(invalidate);
    invalidateOnLifecycle(options.preview, invalidate);
  }

  /** The OpenOrc account; null in a core given no account server. Made at its first use. */
  /** Whose OpenOrc Cloud this Mac is signed in to, for a phone that would have a session of its own of it. */
  private cloudOwner(): CloudSessionOwner | null {
    const server = this.options.accountServer;
    const status = server ? this.account?.account.status() : undefined;
    return server && status?.state === "signed-in" ? { server, email: status.email } : null;
  }

  /** A one-time code for a phone's own session of the person's OpenOrc Cloud, bound to the phone's challenge. */
  private async cloudGrant(input: { challenge: string; device: string }): Promise<CloudSessionGrant> {
    const owner = this.cloudOwner();
    const account = this.account;
    if (!owner || !account) throw new Error(NO_CLOUD_SESSION);
    return { ...owner, ...(await account.account.grantSignIn(input)) };
  }

  /** Threads moving between this Mac and OpenOrc Cloud, made on first use. */
  get cloudMoves(): CloudMoves {
    this.cloudMoveService ??= new CloudMoves({
      db: this.db,
      hosted: () => this.account,
      sessions: new AgentSessions({
        db: this.db,
        dataDir: this.options.dataDir,
        homes: agentHomes({
          environment: () => this.environment.current(),
          claudeFolder: (accountId) => {
            const id = accountId ?? this.claudeAccounts.defaultId();
            return storedClaudeAccounts.get(this.db, id) ? this.claudeAccounts.configDirectory(id) : null;
          },
        }),
      }),
      ledger: this.ledger,
      workspaces: this.workspaces,
      deleteThread: (id) => this.threads.delete(id),
      changed: (id) => this.options.transport.push({ type: "invalidate", keys: ["threads", `thread:${id}`] }),
      here: computerNames(process.platform),
      log: this.log,
    });
    return this.cloudMoveService;
  }

  /** Cloud threads' code read here without moving them, made on first use. */
  get cloudCopies(): CloudCopies {
    this.cloudCopyService ??= new CloudCopies({
      db: this.db,
      hosted: () => this.account,
      dataDir: this.options.dataDir,
      invalidate: (keys) => this.options.transport.push({ type: "invalidate", keys }),
      here: computerNames(process.platform),
    });
    return this.cloudCopyService;
  }

  get account(): Hosted | null {
    if (this.hosted === undefined)
      this.hosted = accountFor(
        this.options,
        {
          db: this.db,
          windows: this.accountTransport,
          notices: () => this.settings.get().notifications,
          claude: this.claudeAccounts,
          skills: this.ownSkills(),
          log: this.log,
          spaceLeft: (left) => void this.hostedFiles.forgetSpace(left).catch((error: unknown) => this.log.warn(`hosted files: a left organization's drafts could not be forgotten: ${String(error)}`)),
        },
        this.textGeneration,
      );
    return this.hosted;
  }

  /** The person's own skills on this Mac, each agent's, as their cloud turns get them. Claude's are its default account's. */
  private ownSkills(): OwnSkills {
    const skills = new HostedSkills({
      root: this.options.dataDir,
      claudeEnv: () => this.claudeAccounts.environment(this.environment.current(), this.claudeAccounts.defaultId()).env,
      // What a set leaves out is said in the composer; it is read again when it changes.
      changed: () => this.options.transport.push({ type: "invalidate", keys: ["hostedSkillsLeftOut"] }),
      off: (agent) => this.settings.get().cloudSkillsOff[agent] ?? [],
    });
    this.hostedSkills = skills;
    return (agent) => skills.own(agent);
  }

  /** Phones choose their own alerts, so they hear every notice; "Desktop notifications" is the windows' switch. */
  private notify(n: Omit<Notification, "type">): void {
    const notice: Notification = { type: "notify", ...n, id: n.id ?? randomUUID() };
    this.remote.alert(notice);
    if (this.settings.get().notifications) this.options.transport.push(notice);
  }

  /** Phones watching its Preview hear so, and main closes its pages. */
  private previewGone(threadId: string): void {
    this.remote.previewGone(threadId);
    this.options.preview?.threadGone(threadId);
  }

  private backgroundProviders(): ProviderInfo {
    return {
      models: (agent, accountId) => this.runs.models(agent, undefined, undefined, accountId),
      loggedIn: (accountId) =>
        this.claudeSystemInfo(accountId).then(
          (info) => Object.fromEntries(info.harnesses.map((row) => [row.id, this.settings.enabledHarnesses().includes(row.id) && harnessLoggedIn(row)])) as Record<HarnessId, boolean>,
        ),
      launch: (agent, accountId) => {
        if (!this.settings.enabledHarnesses().includes(agent)) return null;
        if (this.runs.agentUpdating(agent)) return null;
        try {
          const snapshot = this.environment.current();
          return captureLaunchEnvironment(agent, agent === "claude" ? this.claudeAccounts.environment(snapshot, accountId) : snapshot);
        } catch {
          return null;
        }
      },
    };
  }

  /** What the run module asks of the rest of the app: briefs, permissions, the environment, and what to do as turns end. */
  private runHooks(notify: (n: Omit<Notification, "type">) => void): RunHooks {
    const { options, db } = this;
    return {
      browserAvailable: Boolean(options.browser),
      enabledHarnesses: () => this.settings.enabledHarnesses(),
      processRegistry: path.join(options.dataDir, "agent-processes"),
      idleTimeoutMs: () => {
        const minutes = this.settings.get().idleProcessMinutes;
        return minutes ? minutes * 60_000 : null;
      },
      claudeUserMcpServers: () => this.settings.get().claudeUserMcpServers,
      claudeConnectorsOff: () => this.settings.get().claudeConnectorsOff,
      orclings: this.orclings.runHooks,
      taskImages: (spec) => new AttachmentService(options.dataDir).forTask(spec),
      inlineToolImages: (output) => this.toolImages.inline(output),
      storeToolImages: (ev) => this.toolImages.withStoredImages(ev),
      brief: (project) => this.memory.brief(project),
      threadContext: (thread) => this.pullRequests.brief(thread),
      untrustedCheckout: (thread) => inUnvettedCopy(db, thread),
      memoryEnabled: () => this.memory.enabled(),
      environment: () => this.devices.launchEnvironment(this.environment.current()),
      claudeEnvironment: (snapshot, id) => this.claudeAccounts.environment(snapshot, id),
      claudeAccountFor: (input) => claudeRunAccount(this.db, input),
      claudeVersion: (snapshot, env) => (snapshot ? this.system.infoFor(snapshot, env) : this.system.info()).then((info) => harnessInfo(info, "claude").version),
      editorSaves: (root, since) => this.files.savedSince(root, since),
      onProviderEvent: (event) => this.providerUsage.observe(event),
      onEvent: (event) => {
        this.slack?.observe(event);
        this.comments?.observe(event);
      },
      onRunFinished: (run, scope, project) => {
        this.memory.onRunFinished(run, { task: scope.task, thread: scope.thread ?? this.threads.scopeThreadFor(scope) }, project);
        if (scope.task) void this.threads.onTaskRunFinished(run, scope.task);
      },
      onTurnSettled: (run, scope, _project, outcome) => {
        this.comments?.settled(run, outcome);
        if (scope.comment) return;
        this.claudeAccountSwitch.settled(run, scope, outcome);
        this.claudeSignInRetry.settled(run, scope, outcome);
        this.slack?.settled(run.id, outcome);
      },
      onThreadTurn: (thread, exchange) => {
        void this.threads.onTurnCompleted(thread, exchange);
      },
      onThreadIdle: (thread) => {
        this.threads.onIdle(thread);
      },
      notify: (event) => {
        notify(event);
      },
    };
  }

  static async create(options: OpenOrcOptions): Promise<OpenOrc> {
    await mkdir(options.dataDir, { recursive: true });
    try {
      await recoverAgentProcesses(path.join(options.dataDir, "agent-processes"));
    } catch (error) {
      options.transport.push({ type: "startup", message: `Agent recovery needs attention: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
    const file = path.join(options.dataDir, "openorc.sqlite");
    const db = options.ephemeral ? Db.memory() : Db.open(file);
    if (!options.ephemeral && LedgerUpkeep.needsCompaction(db, options.dataDir)) {
      options.transport.push({ type: "startup", message: "Tidying up saved history. This happens once and can take a minute." });
      // Best effort: the file works as it is, and a failed rebuild waits a few days before trying again.
      await LedgerUpkeep.compact(db, file).catch((error: unknown) => transportLogger(options.transport).warn(`ledger compaction skipped: ${error instanceof Error ? error.message : String(error)}`));
    }
    await ensureWorkspaceHome(db, options.dataDir);
    await removeOwnCloud(db, options.dataDir, transportLogger(options.transport));
    const core = new OpenOrc(options, db);
    // Runs the last instance left open get their ending before anyone sees them as alive.
    core.runs.recoverInterrupted();
    core.comments.recover();
    plans.recover(db);
    // Ready means launchable: nothing may be admitted before the login shell has answered once.
    const shell = await core.environment.refresh();
    if (!shell.ok) core.log.warn(`could not read the login shell environment, launching with the app's own: ${shell.error}`);
    const mcp = await core.mcpServer();
    options.transport.push({ type: "ready", pid: process.pid, mcpPort: mcp.port });
    core.lifecycle.start();
    core.schedules.start();
    core.orclingWakes.start();
    core.threads.recoverQueue();
    core.upkeep.start();
    if (!options.ephemeral) core.agentUpdates.start();
    // Moves between this Mac and the cloud that a quit cut short are finished or undone once the account is heard.
    void core.account
      ?.start()
      .then(() => core.cloudMoves.resume())
      .catch((error: unknown) => core.log.warn(`moves between this Mac and OpenOrc Cloud couldn't be picked up: ${error instanceof Error ? error.message : String(error)}`));
    void core.devices.reapStale();
    // Embed any memories that predate the vector index, off the startup path.
    void core.memory.backfillVectors().catch(() => undefined);
    return core;
  }
  /** Every agent's connectors, made on first use: reading them starts the agents' servers. */
  get connectors(): ConnectorService {
    this.connectorService ??= new ConnectorService(
      connectorPlaces(this.db, () => this.environment.current(), this.claudeAccounts),
      this.settings,
      () => this.options.transport.push({ type: "invalidate", keys: ["connectors"] }),
      { remembered: rememberedConnectors(this.db) },
    );
    return this.connectorService;
  }

  async mcpServer(): Promise<OpenOrcMcpServer> {
    if (!this.mcp) {
      const { assertRunAvailable, taskFor, projectFor } = createContextHost({ db: this.db });
      const threadsHost = createThreadsHost({ threadService: this.threads, db: this.db, assertRunAvailable });
      // A Mac agent's tools for its own project's tasks on OpenOrc Cloud, where the server opens them.
      const online = new OnlineTaskTools({
        account: () => this.account,
        projectFor: (runId) => {
          try {
            return projectFor(runId);
          } catch {
            return null;
          }
        },
        captureProcess: (runId) => this.runs.captureProcess(runId),
      });
      this.mcp = startMcpServer({
        ...createRunHost({ runService: this.runs, db: this.db, comments: this.comments, assertRunAvailable }),
        ...createBrowserHost({ db: this.db, runService: this.runs, browser: this.options.browser, assertRunAvailable }),
        ...createDeviceHost({ db: this.db, runService: this.runs, devices: this.devices, assertRunAvailable }),
        ...createMemoryHost({ memoryService: this.memory, runService: this.runs, db: this.db, assertRunAvailable, taskFor, projectFor, online }),
        onlineTaskScopes: (runId) => online.scopes(runId),
        execution: {
          available: (runId) => this.slack.executionAvailable(runId),
          context: (runId) => this.slack.executionContext(runId),
          switch: (runId, input) => (input.orclingId ? this.slack.switchToOrcling(runId, input.orclingId, input.instructions) : this.slack.switchExecution(runId, input)),
        },
        ...threadsHost,
        ...createOrclingHost({
          db: this.db,
          orclings: this.orclings,
          memory: this.memory,
          runs: this.runs,
          threads: this.threads,
          settings: this.settings,
          send: threadsHost.threads.send,
          planLimits: () => this.planLimits(),
          guard: guardContext(this.db, this.options.dataDir),
          call: (method, params) => this.callAsPerson(method, params),
          invalidate: (keys) => this.options.transport.push({ type: "invalidate", keys }),
        }),
        pullReview: this.pullRequests.agentTools(),
        tasks: {
          ...createTasksHost({ threadService: this.threads, dataDir: this.options.dataDir, assertRunAvailable, online }),
          create: createTaskCreateHost({ threadService: this.threads, assertRunAvailable, online }),
        },
      });
    }
    return this.mcp;
  }

  /**
   * Dispatch one renderer request and resolve to its reply. Never rejects: failures resolve to rpc.error. The caller
   * posts the reply on the port the request came from, because every window counts request ids from 1. A phone's
   * request names its origin, which the handler's audit rows can read for as long as it runs.
   */
  async handle(request: RpcRequest, origin?: RequestOrigin): Promise<RpcReply> {
    // A window's call may be about a thread OpenOrc Cloud holds.
    if (!origin) return this.places.handle(request);
    // A phone's stays on this Mac, unless its session shares cloud threads: then it asks what a phone may, as itself.
    if (!origin.cloud) return this.dispatch(request, origin);
    return requestOrigin.run(origin, () => this.phonePlaces.handle(request));
  }

  /** OpenOrc Cloud's threads first, by lookup; then this Mac. */
  private get places(): PlaceRouter {
    this.placeRouter ??= new PlaceRouter({
      place: () => this.account?.threads ?? null,
      spaces: () => this.account?.spaces ?? null,
      next: (request) => this.dispatch(request),
      movedHere: (threadId) => moveJournal.cameHere(this.db, threadId),
    });
    return this.placeRouter;
  }

  /** The same router over OpenOrc Cloud cut down to what a phone may ask of it; what goes on to this Mac keeps the phone's origin. */
  private get phonePlaces(): PlaceRouter {
    this.phonePlaceRouter ??= new PlaceRouter({
      place: () => this.phoneCloud(),
      spaces: () => this.account?.spaces ?? null,
      next: (request) => this.dispatch(request, requestOrigin.getStore()),
      movedHere: (threadId) => moveJournal.cameHere(this.db, threadId),
    });
    return this.phonePlaceRouter;
  }

  private phoneCloud(): HostedThreads | null {
    const threads = this.account?.threads;
    if (threads) this.phonePlace ??= phoneCloudPlace(threads);
    return threads ? (this.phonePlace ?? null) : null;
  }

  private async dispatch(request: RpcRequest, origin?: RequestOrigin): Promise<RpcReply> {
    const { id, method } = request;
    try {
      if (!Object.hasOwn(rpcParams, method)) return { type: "rpc.error", id, message: `unknown method ${method}` };
      const parsed = rpcParams[method as RpcMethod].safeParse(request.params ?? {});
      if (!parsed.success) return { type: "rpc.error", id, message: invalidParamsMessage(method, parsed.error.message) };
      const handler = this.handlers[method as RpcMethod] as (p: unknown) => Promise<unknown> | unknown;
      const started = Date.now();
      const result = await requestOrigin.run(origin, () => handler(parsed.data));
      if (process.env["OPENORC_RPC_LOG"] === "1") {
        console.log(rpcLogLine(method, parsed.data, result, Date.now() - started));
      }
      return { type: "rpc.result", id, result: result ?? null };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const message = method.startsWith("slack.") ? redact(detail).text : detail;
      this.log.error(`${method}: ${message}`);
      return { type: "rpc.error", id, message };
    }
  }

  /** Why closing now would cut something short, or null when nothing would. */
  busy(): BusyReason | null {
    return busyReason(this);
  }

  /** Called without yielding after the desktop has fenced incoming RPCs. A successful reservation is followed by close(). */
  prepareForUpdate(): string | null {
    const refusal = fenceForUpdate(this);
    if (refusal === null) this.closingForUpdate = true;
    return refusal;
  }

  async close(): Promise<void> {
    await this.hostedFiles.close();
    this.account?.close();
    await this.remote.close(this.closingForUpdate ? "update" : "shutdown");
    await this.files.intelligence.close();
    this.threads.stopAccepting();
    await this.claudeAccounts.close();
    await this.agentUpdates.close();
    await this.comments.close();
    await this.slack.close();
    this.lifecycle.stop();
    this.reviewerApp.shutdown();
    await this.upkeep.stop();
    this.orclingWakes.stop();
    await this.schedules.shutdown();
    await this.workspaces.shutdown();
    await this.runs.closeAll();
    await this.devices.close();
    await this.threads.shutdown();
    await this.memory.shutdown();
    this.bench.stop();
    this.ledger.close();
    await this.providerLog.close();
    if (this.mcp) await (await this.mcp).close();
    this.db.close();
  }

  private async claudeSystemInfo(id?: string | null, refresh = false) {
    if (refresh) await this.environment.refresh();
    return this.system.infoFor(this.claudeAccounts.inspectionEnvironment(this.environment.current(), id ?? undefined));
  }

  /** One call into the core as the Mac's own windows make it, for an Orcling acting for the person. */
  private async callAsPerson(method: string, params: unknown): Promise<unknown> {
    const reply = await this.handle({ type: "rpc", id: 0, method, params });
    if (reply.type === "rpc.error") throw new Error(reply.message);
    return reply.result;
  }

  /** What is left of each plan the person has, as the sidebar, the phone and their Orclings read it. */
  private planLimits() {
    return readPlanLimits({
      db: this.db,
      usage: this.providerUsage,
      availability: async () => harnessAvailability(await this.claudeSystemInfo()).filter((row) => this.settings.enabledHarnesses().includes(row.id)),
    });
  }

  private buildHandlers(invalidate: (keys: string[]) => void): Handlers {
    return composeHandlers(
      createSlackHandlers({ slack: this.slack, invalidate }),
      createCloudHandlers(),
      createClaudeAccountHandlers(this.claudeAccounts),
      createHostedHandlers(this.account, this.hostedFiles, this.db, new TeamChatOrclingCalls({ db: this.db, orclings: this.orclings, textGeneration: this.textGeneration, log: this.log })),
      createHostedSkillsCloudHandlers(() => this.hostedSkills, this.settings),
      createCloudMovesHandlers(
        () => this.cloudMoves,
        () => this.cloudCopies,
      ),
      createMacProjectsHandlers(new MacProjects({ db: this.db, hosted: () => this.account, changed: () => this.options.transport.push({ type: "invalidate", keys: ["macProjects"] }) })),
      hostedParityHandlers,
      threadCollaborationHandlers,
      createAccountPersonHandlers(() => this.account),
      createUsageHandlers({ db: this.db, ledger: this.ledger }),
      createConnectorHandlers({ db: this.db, connectors: this.connectors }),
      createSystemHandlers({
        system: this.system,
        accountInfo: (refresh, id) => (id ? this.claudeSystemInfo(id, refresh) : this.system.info(refresh)),
        defaultAccountInfo: () => this.claudeSystemInfo(),
        enabledHarnesses: () => this.settings.enabledHarnesses(),
        agentUpdates: this.agentUpdates,
        providerUsage: this.providerUsage,
        planLimits: () => this.planLimits(),
        invalidate,
      }),
      createProjectsHandlers({ db: this.db, projectService: this.projects, invalidate, transport: this.options.transport }),
      createPullRequestHandlers({ pullRequests: this.pullRequests }),
      createReviewerAppHandlers({ reviewerApp: this.reviewerApp }),
      createThreadQueriesHandlers({ threadService: this.threads, db: this.db, ledger: this.ledger, imports: this.imports }),
      createThreadLaunchHandlers({ threadService: this.threads, orclings: this.orclings, imports: this.imports }),
      createThreadWorkspaceHandlers({
        db: this.db,
        threadService: this.threads,
        upkeep: this.upkeep,
      }),
      createThreadMessagesHandlers({ db: this.db, threadService: this.threads }),
      createTaskQueriesHandlers({ db: this.db, comments: this.comments, threadService: this.threads, runService: this.runs }),
      createTaskCreateHandlers({ db: this.db, settings: this.settings, threadService: this.threads, invalidate, dataDir: this.options.dataDir }),
      createTaskUpdateHandlers({ threadService: this.threads, db: this.db, runService: this.runs, workspaceWriters: this.workspaceWriters, workspaces: this.workspaces, invalidate }),
      createTaskDeleteHandlers({ workspaces: this.workspaces, comments: this.comments, runService: this.runs, db: this.db, log: this.log, upkeep: this.upkeep, invalidate }),
      createWorkspaceHandlers({ runService: this.runs, workspaces: this.workspaces, db: this.db, invalidate }),
      createWorktreeHandlers({ worktrees: new WorktreeCleanup({ db: this.db, workspaces: this.workspaces, runs: this.runs, writers: this.workspaceWriters, invalidate }) }),
      createRunsHandlers({ threadService: this.threads, runService: this.runs, db: this.db, dataDir: this.options.dataDir }),
      createAttachmentsHandlers({ db: this.db, dataDir: this.options.dataDir }),
      createEventsHandlers({ frames: this.frames, ledger: this.ledger, db: this.db, runService: this.runs }),
      createMcpAppsHandlers({ runService: this.runs }),
      createReviewThreadHandlers({ review: this.review, db: this.db, invalidate }),
      createReviewCommentsHandlers({ review: this.review, invalidate }),
      createReviewWorkspaceHandlers({ review: this.review, db: this.db, taskCheckout: this.taskCheckout, invalidate }),
      createFilesHandlers({ db: this.db, files: this.files }),
      createSkillsHandlers({
        db: this.db,
        files: this.files,
        claudeEnvironment: (id) => this.claudeAccounts.environment(this.environment.current(), id).env,
        claudeLaunch: (id) => captureLaunchEnvironment("claude", this.claudeAccounts.environment(this.environment.current(), id)),
        trash: this.options.trash,
      }),
      createCodeExplanationHandlers({ db: this.db, files: this.files, textGeneration: this.textGeneration, settings: this.settings, dataDir: this.options.dataDir }),
      createInstructionsHandlers({ db: this.db, files: this.files, claudeEnvironment: (id) => this.claudeAccounts.environment(this.environment.current(), id).env }),
      createSettingsHandlers({ settings: this.settings, textGeneration: this.textGeneration, invalidate }),
      createSchedulesHandlers({ schedules: this.schedules }),
      createCatalogHandlers({ runService: this.runs, invalidate }),
      createMemoryHandlers({ memory: this.memory, db: this.db, files: this.files }),
      createOrclingHandlers({ orclings: this.orclings, threads: this.threads, db: this.db, ledger: this.ledger }),
      createDeviceHandlers({ devices: this.devices }),
      createInboxHandlers({ runService: this.runs, db: this.db }),
      createRemoteHandlers({ remote: this.remote }),
      createPreviewHandlers({ db: this.db, preview: this.options.preview }),
      createBenchHandlers({ frames: this.frames, bench: this.bench, db: this.db, ledger: this.ledger, transport: this.options.transport, benchmarks: Boolean(this.options.benchmarks) }),
    );
  }
}
