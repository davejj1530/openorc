import { captureLaunchEnvironment, claudeConfigDir, recoverAgentProcesses } from "@openorc/agents";
import { Db, LedgerWriter, plans, redact, settings as storedSettings } from "@openorc/db";
import { startMcpServer, type OpenOrcMcpServer } from "@openorc/mcp";
import { harnessAvailability, harnessInfo, harnessLoggedIn, rpcParams, type HarnessId, type RpcMethod, type RpcRequest } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { busyReason, fenceForUpdate, type BusyReason } from "./activity.js";
import { BenchGenerator } from "./bench.js";
import { DeviceService } from "./devices/service.js";
import { FrameCoalescer } from "./frames.js";
import { createAttachmentsHandlers } from "./handlers/attachments.js";
import { createBenchHandlers } from "./handlers/bench.js";
import { createCatalogHandlers } from "./handlers/catalog.js";
import { createClaudeAccountHandlers } from "./handlers/claude-accounts.js";
import { createCloudHandlers } from "./handlers/cloud.js";
import { createCodeExplanationHandlers } from "./handlers/code-explanations.js";
import { createDeviceHandlers } from "./handlers/devices.js";
import { invalidParamsMessage, resultSummary } from "./handlers/diagnostics.js";
import { createEventsHandlers } from "./handlers/events.js";
import { createFilesHandlers } from "./handlers/files.js";
import { createInboxHandlers } from "./handlers/inbox.js";
import { createInstructionsHandlers } from "./handlers/instructions.js";
import { createMcpAppsHandlers } from "./handlers/mcp-apps.js";
import { createMemoryHandlers } from "./handlers/memory.js";
import { createOrclingHandlers } from "./handlers/orclings.js";
import { createPreviewHandlers } from "./handlers/preview.js";
import { createProjectsHandlers } from "./handlers/projects.js";
import { createPullRequestHandlers } from "./handlers/pull-requests.js";
import { createBrainThreadHandlers } from "./handlers/brain-threads.js";
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
import { createBrowserHost } from "./mcp-host/browser.js";
import { createContextHost } from "./mcp-host/context.js";
import { createDeviceHost } from "./mcp-host/device.js";
import { createMemoryHost } from "./mcp-host/memory.js";
import { createOrclingHost } from "./mcp-host/orcling.js";
import { createRunHost } from "./mcp-host/run.js";
import { createTaskCreateHost } from "./mcp-host/task-create.js";
import { createTasksHost } from "./mcp-host/tasks.js";
import { createThreadsHost } from "./mcp-host/threads.js";
import type { OpenOrcOptions } from "./options.js";
import { RemoteAccess } from "./remote/remote-access.js";
import { requestOrigin, type RequestOrigin } from "./request-origin.js";
import { AgentUpdateService } from "./services/agent-updates.js";
import { AttachmentService } from "./services/attachments.js";
import { ClaudeAccountService } from "./services/claude-accounts.js";
import { claudeRunAccount } from "./services/claude-run-account.js";
import { withCloudCodexLogin } from "./services/cloud-codex.js";
import { createCloud, type ClaudeCloudTokens, type CloudChecks, type CloudHandoff, type CloudSandboxes, type CloudSettings, type CloudStandby, type CodexCloudLogin } from "./services/cloud-setup.js";
import { CLOUD_IDLE_PROCESS_MS, type CloudWorkspaceService } from "./services/cloud-workspaces.js";
import { createFileService } from "./services/file-service-setup.js";
import type { FileService } from "./services/files.js";
import { ImportService } from "./services/imports.js";
import { LedgerUpkeep } from "./services/ledger-upkeep.js";
import { LifecycleService } from "./services/lifecycle.js";
import { MemoryService, type ProviderInfo } from "./services/memory.js";
import { OrclingService } from "./services/orclings.js";
import { readPlanLimits } from "./services/plan-limits.js";
import { invalidateOnLifecycle } from "./services/preview.js";
import { ProjectService } from "./services/projects.js";
import type { ThreadRelocations } from "./services/relocations.js";
import { BrainRouting } from "./services/brain-routing.js";
import { ProviderLog } from "./services/provider-log.js";
import { ProviderUsageService } from "./services/provider-usage.js";
import { PullRequestService } from "./services/pull-requests.js";
import { inUnvettedCopy } from "./services/review-copies.js";
import { ReviewService } from "./services/review.js";
import { ReviewerAppService } from "./services/reviewer-app.js";
import { RunService, type Notification, type RunHooks } from "./services/runs.js";
import { ScheduleService } from "./services/schedules.js";
import { AppSettingsService } from "./services/settings.js";
import { ShellEnvironment, inheritedProbe } from "./services/shell-environment.js";
import { SlackService } from "./services/slack/service.js";
import { SystemService } from "./services/system.js";
import { TaskCheckoutService } from "./services/task-checkout.js";
import { TaskCommentService } from "./services/task-comments.js";
import { TextGenerationService } from "./services/text-generation.js";
import { ThreadService } from "./services/threads.js";
import { ToolImageStore } from "./services/tool-images.js";
import { ensureWorkspaceHome } from "./services/workspace-home.js";
import { WorkspaceWriters } from "./services/workspace-writers.js";
import { WorkspaceService } from "./services/workspace.js";
import { transportLogger, type Logger, type RpcReply } from "./transport.js";

/**
 * The application core. One instance per app, living in the utility process.
 * The renderer talks to it only through `handle`, so every capability is a
 * validated method and every push is a typed message.
 */
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
  /** Cloud conversations, their sandboxes, Settings and sign-ins, moving and carrying them on: see `createCloud`. */
  readonly cloud: CloudWorkspaceService;
  readonly cloudSettings: CloudSettings;
  readonly claudeCloudTokens: ClaudeCloudTokens;
  readonly codexCloudLogin: CodexCloudLogin;
  readonly cloudChecks: CloudChecks;
  readonly cloudSandboxes: CloudSandboxes;
  readonly cloudHandoff: CloudHandoff;
  readonly cloudStandby: CloudStandby;
  private routing: BrainRouting | null | undefined;
  private readonly cloudParts: ReturnType<typeof createCloud>;
  readonly runs: RunService;
  readonly comments: TaskCommentService;
  readonly review: ReviewService;
  readonly taskCheckout: TaskCheckoutService;
  readonly system: SystemService;
  readonly agentUpdates: AgentUpdateService;
  /** The environment agents launch with. Runs capture `current()` at admission; Rescan calls `refresh()`. */
  readonly claudeAccounts: ClaudeAccountService;
  readonly environment: ShellEnvironment;
  readonly providerUsage: ProviderUsageService;
  readonly memory: MemoryService;
  readonly orclings: OrclingService;
  readonly textGeneration: TextGenerationService;
  readonly threads: ThreadService;
  readonly settings: AppSettingsService;
  readonly lifecycle: LifecycleService;
  readonly pullRequests: PullRequestService;
  readonly reviewerApp: ReviewerAppService;
  readonly schedules: ScheduleService;
  readonly files: FileService;
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
    });
    this.settings = new AppSettingsService(db);
    this.environment = new ShellEnvironment({ probe: options.shellProbe ?? (options.ephemeral ? inheritedProbe() : undefined) });
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
      (id) => Boolean(this.agentUpdates?.get().updating || this.memory?.hasPendingWork || this.textGeneration?.hasPendingWork || this.runs?.hasClaudeSessions(id)),
      (id) => this.runs.retireIdleClaudeSessions(id),
      options.cloudOnly ? (id) => this.claudeCloudTokens.known(id) : undefined,
    );
    this.agentUpdates = new AgentUpdateService({
      info: (refresh) => this.system.info(refresh),
      environment: () => this.environment.current(),
      reserve: async () => {
        if (this.claudeAccounts.hasPendingWork || this.memory.hasPendingWork || this.textGeneration.hasPendingWork || this.schedules.hasPendingWork) {
          throw new Error("Finish agent work and background processing before updating. Your conversations will be kept.");
        }
        return this.runs.reserveAgentUpdate();
      },
      changed: () => invalidate(["agent-updates"]),
      refreshed: () => invalidate(["system", "models"]),
      read: (key) => storedSettings.get(db, key),
      write: (key, value) => storedSettings.set(db, key, value),
    });
    // The renderer decides whether the thread is already on screen.
    const notify = (n: Omit<Notification, "type">) => this.notify(n);
    this.projects = new ProjectService(db);
    const cloud = createCloud({
      db,
      ledger: this.ledger,
      options,
      accounts: this.claudeAccounts,
      environment: () => this.environment.current(),
      runs: () => this.runs,
      threads: () => this.threads,
      workspaces: () => this.workspaces,
      invalidate,
      brainChanged: () => void this.brainRouting?.refresh(),
      log: this.log,
    });
    this.cloudParts = cloud;
    this.cloudSettings = cloud.settings;
    this.claudeCloudTokens = cloud.tokens;
    this.codexCloudLogin = cloud.codex;
    this.cloud = cloud.cloud;
    this.cloudChecks = cloud.checks;
    this.cloudSandboxes = cloud.sandboxes;
    this.cloudHandoff = cloud.handoff;
    this.cloudStandby = cloud.standby;
    this.workspaces = new WorkspaceService(db, { dataDir: options.dataDir, cloud: this.cloud }, this.log, this.workspaceWriters);
    const backgroundProviders: ProviderInfo = {
      models: (agent, accountId) => this.runs.models(agent, undefined, undefined, accountId),
      loggedIn: (accountId) => this.claudeSystemInfo(accountId).then((info) => Object.fromEntries(info.harnesses.map((row) => [row.id, harnessLoggedIn(row)])) as Record<HarnessId, boolean>),
      launch: (agent, accountId) => {
        if (this.agentUpdates.get().updating) return null;
        try {
          const snapshot = this.environment.current();
          return captureLaunchEnvironment(agent, agent === "claude" ? this.claudeAccounts.environment(snapshot, accountId) : snapshot);
        } catch {
          return null;
        }
      },
    };
    this.memory = new MemoryService(db, { dataDir: options.dataDir, secrets: options.memorySecrets, embedder: options.embedder }, backgroundProviders, invalidate, this.log);
    this.textGeneration = new TextGenerationService(db, backgroundProviders, invalidate);
    this.orclings = new OrclingService({ db, dataDir: options.dataDir, memory: this.memory, runs: () => this.runs, threads: () => this.threads, invalidate });
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
    this.providerUsage = new ProviderUsageService(db, this.system, { apiKey: () => this.memory.credentialStatus() }, (id) =>
      id ? this.claudeAccounts.environment(this.environment.current(), id) : this.environment.current(),
    );
    this.lifecycle = new LifecycleService(db, invalidate, this.log);
    this.schedules = new ScheduleService(db, this.threads, invalidate, notify, this.log, {
      maintenance: () => this.agentUpdates.get().updating,
    });
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
      invalidate,
    });
    this.slack = new SlackService(this, options.slackSecrets, new AttachmentService(options.dataDir));
    this.handlers = this.buildHandlers(invalidate);
    invalidateOnLifecycle(options.preview, invalidate);
  }

  /** Threads moving between this host and the other brain. */
  get relocations(): ThreadRelocations {
    return this.cloudParts.relocations;
  }

  /**
   * A Mac's windows reaching threads its cloud brain holds; null on the brain itself. An ephemeral core keeps no
   * profile, so it neither caches a brain's lists nor dials one. Made at its first use, once the core's parts exist.
   */
  get brainRouting(): BrainRouting | null {
    if (this.routing !== undefined) return this.routing;
    const { options } = this;
    this.routing =
      options.cloudOnly || options.ephemeral
        ? null
        : new BrainRouting({
            db: this.db,
            dataDir: options.dataDir,
            brain: this.cloudParts.brain,
            windows: this.windows,
            local: (request) => this.dispatch(request),
            notificationsOn: () => this.settings.get().notifications,
            log: this.log,
            endpoint: options.brainEndpoint,
          });
    return this.routing;
  }

  /** Phones choose their own alerts, so they hear every notice; "Desktop notifications" is the windows' switch. */
  private notify(n: Omit<Notification, "type">): void {
    const notice: Notification = { type: "notify", ...n, id: n.id ?? randomUUID() };
    this.remote.alert(notice);
    if (this.settings.get().notifications) this.options.transport.push(notice);
  }

  /** A deleted thread's Preview goes with it: phones watching it hear so, and main closes its pages. */
  private previewGone(threadId: string): void {
    this.remote.previewGone(threadId);
    this.options.preview?.threadGone(threadId);
  }

  /** What the run module asks of the rest of the app: briefs, permissions, the environment, and what to do as turns end. */
  private runHooks(notify: (n: Omit<Notification, "type">) => void): RunHooks {
    const { options, db } = this;
    return {
      browserAvailable: Boolean(options.browser),
      processRegistry: path.join(options.dataDir, "agent-processes"),
      idleTimeoutMs: (thread) => {
        const minutes = this.settings.get().idleProcessMinutes;
        const setting = minutes ? minutes * 60_000 : null;
        return thread && this.cloud.get(thread.id) ? Math.min(setting ?? CLOUD_IDLE_PROCESS_MS, CLOUD_IDLE_PROCESS_MS) : setting;
      },
      claudeUserMcpServers: () => this.settings.get().claudeUserMcpServers,
      orclings: this.orclings.runHooks,
      taskImages: (spec) => new AttachmentService(options.dataDir).forTask(spec),
      inlineToolImages: (output) => this.toolImages.inline(output),
      storeToolImages: (ev) => this.toolImages.withStoredImages(ev),
      brief: (project) => this.memory.brief(project),
      threadContext: (thread) => this.pullRequests.brief(thread),
      untrustedCheckout: (thread) => inUnvettedCopy(db, thread),
      cloudHost: (thread, mcpOrigin, run) => this.cloud.host(thread, mcpOrigin, run),
      syncCloud: (thread, sync) => {
        // A turn on this Mac keeps its standby sandbox current, for the cloud to take it over if the Mac sleeps.
        this.cloudStandby.observe(thread, sync);
        return this.cloud.sync(thread, sync).catch((error: unknown) => {
          this.log.warn(`could not bring thread ${thread.id}'s cloud changes to the Mac: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        });
      },
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
    const core = new OpenOrc(options, db);
    // Runs the last instance left open get their ending before anyone sees them as alive.
    core.runs.recoverInterrupted();
    core.comments.recover();
    plans.recover(db);
    // Ready means launchable: nothing may be admitted before the login shell has answered once.
    const shell = await core.environment.refresh();
    if (!shell.ok) core.log.warn(`could not read the login shell environment, launching with the app's own: ${shell.error}`);
    if (options.cloudOnly) await core.claudeCloudTokens.load();
    const mcp = await core.mcpServer();
    options.transport.push({ type: "ready", pid: process.pid, mcpPort: mcp.port });
    core.lifecycle.start();
    core.schedules.start();
    core.threads.recoverQueue();
    core.upkeep.start();
    core.cloudParts.brain.opened();
    core.cloudParts.coordinator?.start();
    void core.brainRouting?.refresh();
    if (!options.ephemeral) core.agentUpdates.start();
    void core.devices.reapStale();
    // Embed any memories that predate the vector index, off the startup path.
    void core.memory.backfillVectors().catch(() => undefined);
    return core;
  }
  async mcpServer(): Promise<OpenOrcMcpServer> {
    if (!this.mcp) {
      const { assertRunAvailable, taskFor, projectFor } = createContextHost({ db: this.db });
      const threadsHost = createThreadsHost({ threadService: this.threads, db: this.db, assertRunAvailable });
      this.mcp = startMcpServer({
        ...createRunHost({ runService: this.runs, db: this.db, comments: this.comments, assertRunAvailable }),
        ...createBrowserHost({ db: this.db, runService: this.runs, browser: this.options.browser, assertRunAvailable }),
        ...createDeviceHost({ db: this.db, runService: this.runs, devices: this.devices, assertRunAvailable }),
        ...createMemoryHost({ memoryService: this.memory, runService: this.runs, db: this.db, assertRunAvailable, taskFor, projectFor }),
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
          invalidate: (keys) => this.options.transport.push({ type: "invalidate", keys }),
        }),
        pullReview: this.pullRequests.agentTools(),
        tasks: {
          ...createTasksHost({ threadService: this.threads, dataDir: this.options.dataDir, assertRunAvailable }),
          create: createTaskCreateHost({ threadService: this.threads, assertRunAvailable }),
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
    // A window's call while a cloud brain is set up may be about a thread the brain holds; a phone's never goes there.
    if (!origin && this.brainRouting?.active) return this.brainRouting.router.handle(request);
    return this.dispatch(request, origin);
  }

  private async dispatch(request: RpcRequest, origin?: RequestOrigin): Promise<RpcReply> {
    const { id, method } = request;
    const privateParams = method.startsWith("slack.") || method === "memory.settings.set" || method === "remote.push.setKey";
    try {
      if (!Object.hasOwn(rpcParams, method)) return { type: "rpc.error", id, message: `unknown method ${method}` };
      const parsed = rpcParams[method as RpcMethod].safeParse(request.params ?? {});
      if (!parsed.success) return { type: "rpc.error", id, message: invalidParamsMessage(method, parsed.error.message) };
      const handler = this.handlers[method as RpcMethod] as (p: unknown) => Promise<unknown> | unknown;
      const started = Date.now();
      const result = await requestOrigin.run(origin, () => handler(parsed.data));
      if (process.env["OPENORC_RPC_LOG"] === "1") {
        console.log(`[rpc] ${method} ${privateParams ? "[private]" : JSON.stringify(parsed.data).slice(0, 120)} -> ${resultSummary(result)} in ${Date.now() - started} ms`);
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
    this.cloudParts.coordinator?.close();
    this.brainRouting?.close();
    await this.remote.close(this.closingForUpdate ? "update" : "shutdown");
    await this.files.intelligence.close();
    this.threads.stopAccepting();
    await this.claudeCloudTokens.close();
    await this.claudeAccounts.close();
    await this.agentUpdates.close();
    await this.comments.close();
    await this.slack.close();
    this.lifecycle.stop();
    this.reviewerApp.shutdown();
    await this.upkeep.stop();
    await this.schedules.shutdown();
    await this.workspaces.shutdown();
    this.cloudStandby.close();
    await this.runs.closeAll();
    await this.cloud.close();
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
    const info = await this.system.infoFor(this.claudeAccounts.inspectionEnvironment(this.environment.current(), id ?? undefined));
    return this.options.cloudOnly ? withCloudCodexLogin(info, await this.codexCloudLogin.has()) : info;
  }

  private buildHandlers(invalidate: (keys: string[]) => void): Handlers {
    return composeHandlers(
      createSlackHandlers({ slack: this.slack, invalidate }),
      createCloudHandlers({ ...this.cloudParts, offered: Boolean(this.options.cloudOffered && !this.options.cloudOnly), invalidate }),
      createClaudeAccountHandlers(this.claudeAccounts),
      createSystemHandlers({
        system: this.system,
        accountInfo: (refresh, id) => (id ? this.claudeSystemInfo(id, refresh) : this.system.info(refresh)),
        defaultAccountInfo: () => this.claudeSystemInfo(),
        agentUpdates: this.agentUpdates,
        providerUsage: this.providerUsage,
        planLimits: () => readPlanLimits({ db: this.db, usage: this.providerUsage, availability: async () => harnessAvailability(await this.claudeSystemInfo()) }),
        invalidate,
      }),
      createProjectsHandlers({ db: this.db, projectService: this.projects, invalidate, transport: this.options.transport, copies: this.options.cloudOnly ?? false }),
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
      createTaskQueriesHandlers({ db: this.db, comments: this.comments, threadService: this.threads }),
      createTaskCreateHandlers({ db: this.db, settings: this.settings, threadService: this.threads, invalidate, dataDir: this.options.dataDir }),
      createTaskUpdateHandlers({ threadService: this.threads, db: this.db, runService: this.runs, workspaceWriters: this.workspaceWriters, workspaces: this.workspaces, invalidate }),
      createTaskDeleteHandlers({ workspaces: this.workspaces, comments: this.comments, runService: this.runs, db: this.db, log: this.log, upkeep: this.upkeep, invalidate }),
      createWorkspaceHandlers({ runService: this.runs, workspaces: this.workspaces, db: this.db, invalidate }),
      createRunsHandlers({ threadService: this.threads, runService: this.runs, db: this.db, dataDir: this.options.dataDir }),
      createAttachmentsHandlers({ db: this.db, dataDir: this.options.dataDir }),
      createEventsHandlers({ frames: this.frames, ledger: this.ledger, db: this.db, runService: this.runs }),
      createMcpAppsHandlers({ runService: this.runs }),
      createReviewThreadHandlers({ review: this.review, db: this.db, invalidate }),
      createReviewCommentsHandlers({ review: this.review, invalidate }),
      createReviewWorkspaceHandlers({ review: this.review, db: this.db, taskCheckout: this.taskCheckout, invalidate }),
      createFilesHandlers({ db: this.db, files: this.files, claudeEnvironment: (id) => this.claudeAccounts.environment(this.environment.current(), id).env }),
      createCodeExplanationHandlers({ db: this.db, files: this.files, textGeneration: this.textGeneration, settings: this.settings, dataDir: this.options.dataDir }),
      createInstructionsHandlers({ db: this.db, files: this.files, claudeEnvironment: (id) => this.claudeAccounts.environment(this.environment.current(), id).env }),
      createSettingsHandlers({ settings: this.settings, textGeneration: this.textGeneration, invalidate }),
      createSchedulesHandlers({ schedules: this.schedules }),
      createCatalogHandlers({ runService: this.runs, invalidate }),
      createMemoryHandlers({ memory: this.memory, db: this.db, files: this.files }),
      createOrclingHandlers({ orclings: this.orclings }),
      createDeviceHandlers({ devices: this.devices }),
      createInboxHandlers({ runService: this.runs, db: this.db }),
      createRemoteHandlers({ remote: this.remote, pushKeyChanged: () => this.cloudParts.brain.signInsChanged() }),
      createBrainThreadHandlers({ db: this.db, cloud: this.cloud, mirrors: () => this.brainRouting?.mirrors ?? null }),
      createPreviewHandlers({ db: this.db, preview: this.options.preview }),
      createBenchHandlers({ frames: this.frames, bench: this.bench, db: this.db, ledger: this.ledger, transport: this.options.transport, benchmarks: Boolean(this.options.benchmarks) }),
    );
  }
}
