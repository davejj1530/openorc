import { invalidParamsMessage, resultSummary } from "./handlers/diagnostics.js";
import { captureLaunchEnvironment, recoverAgentProcesses } from "@openorc/agents";
import {
  Db,
  LedgerWriter,
  orchestration,
  plans,
  redact,
  settings as storedSettings,
  taskForwardings,
  tasks,
  teamDeletedThreads,
  teamForks,
  teamMoves,
  teamRestores,
  teamRuntime,
  threads,
} from "@openorc/db";
import { startMcpServer, type OpenOrcMcpServer } from "@openorc/mcp";
import type { TextEmbedder } from "@openorc/memory";
import type { BrowserHost } from "@openorc/protocol";
import { DEFAULT_TEAM_LIMITS, harnessInfo, harnessInstalled, harnessLoggedIn, rpcParams, type HarnessId, type RpcMethod, type RpcRequest } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BenchGenerator } from "./bench.js";
import { FrameCoalescer } from "./frames.js";
import { createAttachmentsHandlers } from "./handlers/attachments.js";
import { createBenchHandlers } from "./handlers/bench.js";
import { createCatalogHandlers } from "./handlers/catalog.js";
import { createEventsHandlers } from "./handlers/events.js";
import { createFilesHandlers } from "./handlers/files.js";
import { createInboxHandlers } from "./handlers/inbox.js";
import { createMcpAppsHandlers } from "./handlers/mcp-apps.js";
import { createMemoryHandlers } from "./handlers/memory.js";
import { createOrchestrationHandlers } from "./handlers/orchestration.js";
import { createProjectsHandlers } from "./handlers/projects.js";
import { createPullRequestHandlers } from "./handlers/pull-requests.js";
import { createReviewerAppHandlers } from "./handlers/reviewer-app.js";
import { createReviewCommentsHandlers } from "./handlers/review-comments.js";
import { createReviewThreadHandlers } from "./handlers/review-thread.js";
import { createReviewWorkspaceHandlers } from "./handlers/review-workspace.js";
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
import { createMemoryHost } from "./mcp-host/memory.js";
import { createRunHost } from "./mcp-host/run.js";
import { createTaskCreateHost } from "./mcp-host/task-create.js";
import { createTasksHost } from "./mcp-host/tasks.js";
import { createTeamHost } from "./mcp-host/team.js";
import { createThreadsHost } from "./mcp-host/threads.js";
import { AgentUpdateService } from "./services/agent-updates.js";
import { AttachmentService } from "./services/attachments.js";
import type { ProtectedSecretStore } from "./services/extraction-credentials.js";
import { FileService } from "./services/files.js";
import { ImportService } from "./services/imports.js";
import { LedgerUpkeep } from "./services/ledger-upkeep.js";
import { LifecycleService } from "./services/lifecycle.js";
import { MemoryService, type ProviderInfo } from "./services/memory.js";
import { OrchestrationService } from "./services/orchestration.js";
import { ProjectService } from "./services/projects.js";
import { ProviderLog } from "./services/provider-log.js";
import { ProviderUsageService } from "./services/provider-usage.js";
import { PullRequestService } from "./services/pull-requests.js";
import { ReviewerAppService } from "./services/reviewer-app.js";
import { ReviewService } from "./services/review.js";
import { RunService, type Notification } from "./services/runs.js";
import { ScheduleService } from "./services/schedules.js";
import { AppSettingsService } from "./services/settings.js";
import { ShellEnvironment, inheritedProbe, type ShellProbe } from "./services/shell-environment.js";
import { SlackService, type SlackSecretStore } from "./services/slack/service.js";
import { SystemService } from "./services/system.js";
import { TaskCheckoutService } from "./services/task-checkout.js";
import { TaskCommentService } from "./services/task-comments.js";
import { TaskForwardingService } from "./services/task-forwarding.js";
import { TeamConversationService } from "./services/team-conversation.js";
import { TeamCoordinator } from "./services/team-coordinator.js";
import { TeamDeletionService } from "./services/team-deletions.js";
import { TeamForkService } from "./services/team-forks.js";
import { TeamMoveService } from "./services/team-moves.js";
import { TeamNotificationService } from "./services/team-notifications.js";
import { TeamOperationGuard } from "./services/team-operations.js";
import { TeamRestoreService } from "./services/team-restores.js";
import { teamTaskExportAvailability } from "./services/team-task-export.js";
import { TeamTaskService } from "./services/team-tasks.js";
import { TeamWorkspaceService } from "./services/team-workspaces.js";
import { TextGenerationService } from "./services/text-generation.js";
import { ThreadService } from "./services/threads.js";
import { ToolImageStore } from "./services/tool-images.js";
import { ensureWorkspaceHome } from "./services/workspace-home.js";
import { WorkspaceWriters } from "./services/workspace-writers.js";
import { WorkspaceService } from "./services/workspace.js";
import { transportLogger, type Logger, type Transport } from "./transport.js";

export interface OpenOrcOptions {
  browser?: BrowserHost;
  slackSecrets?: SlackSecretStore;
  memorySecrets?: ProtectedSecretStore;
  /** Keeps the reviewer app's private key. Without it, reviews post only as the user. */
  githubSecrets?: ProtectedSecretStore;
  /** Where memory's embedding model runs. Defaults to the core's own thread, where loading it and each batch block everything else. */
  embedder?: TextEmbedder;
  dataDir: string;
  transport: Transport;
  /** In-memory database, for tests. */
  ephemeral?: boolean;
  /**
   * How the login shell is asked for PATH and the harness binaries. Defaults
   * to the real shell, except that an ephemeral core inherits this process's
   * environment instead: a test should not pay for a login shell it never
   * asked about. Pass a probe to test that path on purpose.
   */
  shellProbe?: ShellProbe;
  /** Serves the bench.* methods, which stream synthetic events and write a synthetic thread into the ledger. Development and QA builds only. */
  benchmarks?: boolean;
}

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
  readonly runs: RunService;
  readonly comments: TaskCommentService;
  readonly review: ReviewService;
  readonly taskCheckout: TaskCheckoutService;
  readonly taskForwarding: TaskForwardingService;
  readonly system: SystemService;
  readonly agentUpdates: AgentUpdateService;
  /** The environment agents launch with. Runs capture `current()` at admission; Rescan calls `refresh()`. */
  readonly environment: ShellEnvironment;
  readonly providerUsage: ProviderUsageService;
  readonly memory: MemoryService;
  readonly textGeneration: TextGenerationService;
  readonly threads: ThreadService;
  readonly settings: AppSettingsService;
  readonly lifecycle: LifecycleService;
  readonly pullRequests: PullRequestService;
  readonly reviewerApp: ReviewerAppService;
  readonly schedules: ScheduleService;
  readonly files: FileService;
  readonly imports: ImportService;
  readonly orchestration: OrchestrationService;
  readonly teams: TeamCoordinator;
  readonly teamWorkspaces: TeamWorkspaceService;
  readonly teamConversations: TeamConversationService;
  readonly teamTasks: TeamTaskService;
  readonly teamNotifications: TeamNotificationService;
  readonly teamOperations: TeamOperationGuard;
  readonly teamForks: TeamForkService;
  readonly teamRestores: TeamRestoreService;
  readonly teamMoves: TeamMoveService;
  readonly teamDeletions: TeamDeletionService;
  readonly workspaceWriters = new WorkspaceWriters();
  private readonly log: Logger;
  private readonly bench: BenchGenerator;
  private mcp: Promise<OpenOrcMcpServer> | null = null;
  private readonly handlers: Handlers;

  private constructor(
    private readonly options: OpenOrcOptions,
    db: Db,
  ) {
    this.db = db;
    this.log = transportLogger(options.transport);
    this.providerLog = new ProviderLog(path.join(options.dataDir, "logs", "provider"));
    this.toolImages = new ToolImageStore(options.dataDir);
    this.ledger = new LedgerWriter(db, { native: (ev) => this.providerLog.write(ev), storeImage: (runId, image) => this.toolImages.save(runId, image) });
    this.upkeep = new LedgerUpkeep(db, { log: this.log, toolImages: this.toolImages });
    this.frames = new FrameCoalescer((frame) => options.transport.push({ type: "frame", frame }));
    this.bench = new BenchGenerator((ev) => this.frames.push(ev));
    const invalidate = (keys: string[]) => options.transport.push({ type: "invalidate", keys });
    this.settings = new AppSettingsService(db);
    this.environment = new ShellEnvironment({ probe: options.shellProbe ?? (options.ephemeral ? inheritedProbe() : undefined) });
    this.system = new SystemService(options.dataDir, this.environment);
    this.agentUpdates = new AgentUpdateService({
      info: (refresh) => this.system.info(refresh),
      environment: () => this.environment.current(),
      reserve: async () => {
        if (this.memory.hasPendingWork || this.textGeneration.hasPendingWork || teamRuntime.openIds(this.db).length || this.schedules.hasPendingWork) {
          throw new Error("Finish agent work, teams, and background processing before updating. Your conversations will be kept.");
        }
        return this.runs.reserveAgentUpdate();
      },
      changed: () => invalidate(["agent-updates"]),
      refreshed: () => invalidate(["system", "models"]),
      read: (key) => storedSettings.get(db, key),
      write: (key, value) => storedSettings.set(db, key, value),
    });
    // Notifications are the user's call; the renderer decides whether the thread is already on screen.
    const notify = (n: Omit<Notification, "type">) => {
      if (this.settings.get().notifications) options.transport.push({ type: "notify", ...n, id: n.id ?? randomUUID() });
    };
    this.projects = new ProjectService(db);
    this.workspaces = new WorkspaceService(db, { dataDir: options.dataDir }, this.log, this.workspaceWriters);
    const backgroundProviders: ProviderInfo = {
      models: (agent) => this.runs.models(agent),
      loggedIn: () => this.system.info().then((info) => Object.fromEntries(info.harnesses.map((row) => [row.id, harnessLoggedIn(row)])) as Record<HarnessId, boolean>),
      launch: (agent) => {
        if (this.agentUpdates.get().updating) return null;
        try {
          return captureLaunchEnvironment(agent, this.environment.current());
        } catch {
          return null;
        }
      },
    };
    this.memory = new MemoryService(db, { dataDir: options.dataDir, secrets: options.memorySecrets, embedder: options.embedder }, backgroundProviders, invalidate, this.log);
    this.textGeneration = new TextGenerationService(db, backgroundProviders, invalidate);
    this.runs = new RunService(
      db,
      this.ledger,
      this.frames,
      () => this.mcpServer(),
      invalidate,
      this.log,
      {
        browserAvailable: Boolean(options.browser),
        processRegistry: path.join(options.dataDir, "agent-processes"),
        captureTeamTree: (runId, cwd, lease) => this.teamWorkspaces.captureRunCheckpoint(runId, cwd, lease),
        assertStart: (input) => this.teams.assertLaunch(input),
        assertSend: (runId, teamAttemptId) => this.teams.assertSend(runId, teamAttemptId),
        idleTimeoutMs: () => {
          const minutes = this.settings.get().idleProcessMinutes;
          return minutes ? minutes * 60_000 : null;
        },
        claudeUserMcpServers: () => this.settings.get().claudeUserMcpServers,
        taskImages: (spec) => new AttachmentService(options.dataDir).forTask(spec),
        inlineToolImages: (output) => this.toolImages.inline(output),
        brief: (project) => this.memory.brief(project),
        threadContext: (thread) => this.pullRequests.brief(thread),
        memoryEnabled: () => this.memory.enabled(),
        environment: () => this.environment.current(),
        claudeVersion: (snapshot, env) => (snapshot ? this.system.infoFor(snapshot, env) : this.system.info()).then((info) => harnessInfo(info, "claude").version),
        onSteerable: (runId) => this.teams.providerReady(runId),
        onProviderEvent: (event) => this.providerUsage.observe(event),
        onEvent: (event) => {
          this.slack?.observe(event);
          this.comments?.observe(event);
        },
        onApprovalRequested: (event) => this.teamNotifications.approval(event),
        onRunFinished: (run, scope, project) => {
          this.memory.onRunFinished(run, { task: scope.task, thread: scope.thread ?? this.threads.scopeThreadFor(scope) }, project);
          if (scope.task && !this.teams.binding(run.id)) void this.threads.onTaskRunFinished(run, scope.task);
        },
        onTurnSettled: (run, scope, project, outcome) => {
          this.comments?.settled(run, outcome);
          if (scope.comment) return;
          this.teams.onTurnSettled(run, scope, project, outcome);
          this.slack?.settled(run.id, outcome);
        },
        onThreadTurn: (thread, exchange) => {
          if (!orchestration.getInstance(db, thread.id)) void this.threads.onTurnCompleted(thread, exchange);
        },
        onThreadIdle: (thread) => {
          if (!orchestration.getInstance(db, thread.id)) this.threads.onIdle(thread);
        },
        notify: (event) => {
          if (!event.threadId || !orchestration.getInstance(db, event.threadId)) notify(event);
        },
      },
      undefined,
      this.workspaceWriters,
    );
    this.threads = new ThreadService(
      db,
      this.runs,
      this.workspaces,
      invalidate,
      this.log,
      (exchange, agent) => this.textGeneration.title(exchange, agent),
      this.workspaceWriters,
      (id) => this.teams.modeChanged(id),
    );
    this.comments = new TaskCommentService(db, this.runs, this.threads, invalidate, options.dataDir);
    this.orchestration = new OrchestrationService(
      db,
      {
        models: (agent) => this.runs.models(agent),
        // An explicit readiness check should observe a login change immediately.
        status: (agent, refresh) =>
          this.system.info(refresh).then((info) => {
            const row = harnessInfo(info, agent);
            return { installed: harnessInstalled(row), loggedIn: harnessLoggedIn(row) };
          }),
      },
      invalidate,
      { dataDir: options.dataDir },
    );
    this.teamWorkspaces = new TeamWorkspaceService(db, { dataDir: options.dataDir }, this.workspaceWriters);
    this.teamNotifications = new TeamNotificationService(db, this.runs, notify);
    const leadWorkspaces = new Map<string, Promise<unknown>>();
    this.teams = new TeamCoordinator(db, this.runs, {
      assertThreadAvailable: (id, options) => this.teamOperations.assertAvailable(id, undefined, options),
      prepare: async () => {
        throw new Error("Team workspace preparation must use its execution identity.");
      },
      workspace: {
        beforeStart: async (executionId, actorId, assertActive) => {
          const record = teamRuntime.get(db, executionId)!;
          const actor = record.actors.find((item) => item.id === actorId)!;
          // Participants talk in the lead's workspace; it is prepared once, on whichever member speaks first.
          if (actor.participant) {
            if (threads.get(db, record.threadId)?.worktreePath) return;
            const pending = leadWorkspaces.get(executionId) ?? this.teamWorkspaces.prepare(executionId, "lead", assertActive).finally(() => leadWorkspaces.delete(executionId));
            leadWorkspaces.set(executionId, pending);
            await pending;
            return;
          }
          if (actor.parentId) await this.teamWorkspaces.integrate(executionId, actor.parentId, assertActive);
          await this.teamWorkspaces.prepare(executionId, actorId, assertActive);
          await this.teamWorkspaces.integrate(executionId, actorId, assertActive);
        },
        captureOutput: (executionId, actorId, assertActive) => this.teamWorkspaces.captureOutput(executionId, actorId, assertActive),
        assertStopped: (executionId) => this.teamWorkspaces.assertStopped(executionId),
        recoveries: (executionId) => this.teamWorkspaces.pendingRecoveries(executionId),
      },
      validate: async (executionSettings, projectId) => {
        const input = {
          projectId,
          draft: {
            name: "Execution check",
            limits: DEFAULT_TEAM_LIMITS,
            members: [{ key: "member", name: "Member", managerKey: null, responsibility: "Validate the captured execution settings.", settings: executionSettings }],
          },
        };
        // The existing minute-long readiness cache also preserves revision-scoped model catalogs.
        // A stale failure gets one fresh check so installing or signing in unblocks the next turn.
        let result = await this.orchestration.preflight(input, { refresh: false });
        if (!result.ready) result = await this.orchestration.preflight(input);
        if (!result.ready) throw new Error(result.issues.map((issue) => issue.message).join("\n"));
      },
      tasks: {
        hasPendingWork: (record, actor) => this.teamTasks.hasPendingWork(record, actor),
        instructions: (record, actor) => this.teamTasks.instructions(record, actor),
        completionReason: (record, actor, attempt) => this.teamTasks.completionReason(record, actor, attempt),
        settled: (record, actor, attempt, outcome) => this.teamTasks.settled(record, actor, attempt, outcome),
      },
      warn: (message) => this.log.warn(message),
      changed: (threadId, record) => {
        invalidate(["orchestration", "threads", "tasks", `thread:${threadId}`]);
        if (record) {
          try {
            this.teamNotifications.observe(record);
          } catch (error) {
            this.log.warn(`Team notification failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
    });
    this.teamOperations = new TeamOperationGuard(
      db,
      (id) => {
        const reason = this.threads.teamQuiescenceReason(id);
        if (reason) return reason;
        try {
          this.teams.assertQuiescent(id);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      (id) => invalidate(["orchestration", `thread:${id}`]),
    );
    const taskExport = (taskId: string) => teamTaskExportAvailability(db, { coordinator: this.teams, guard: this.teamOperations }, taskId);
    this.taskCheckout = new TaskCheckoutService(db, this.workspaceWriters, options.dataDir);
    this.review = new ReviewService(db, this.workspaceWriters, this.teamOperations, { dataDir: options.dataDir, taskExport, conversations: this.threads });
    this.teamForks = new TeamForkService(db, options.dataDir, this.teamOperations, this.workspaceWriters, (id) =>
      invalidate(["workspace-diff", "orchestration", "threads", `thread:${id}`, `threaddiff:${id}`]),
    );
    const workspaceReplaced = (id: string) => invalidate(["workspace-diff", "orchestration", "threads", `thread:${id}`, `threaddiff:${id}`, `threadlog:${id}`, `checkpoints:${id}`]);
    this.teamRestores = new TeamRestoreService(db, options.dataDir, this.teamOperations, this.workspaceWriters, workspaceReplaced);
    this.teamMoves = new TeamMoveService(db, options.dataDir, this.teamOperations, this.workspaceWriters, workspaceReplaced);
    this.teamDeletions = new TeamDeletionService(db, options.dataDir, this.teamOperations, this.workspaceWriters, (id) => {
      invalidate(["orchestration", "threads", "tasks", "inbox", `thread:${id}`]);
      // What deleted runs leave outside the database goes with them.
      void this.upkeep.forgetDeletedRuns();
    });
    this.teamConversations = new TeamConversationService(
      db,
      this.teams,
      this.runs,
      this.settings,
      invalidate,
      (id) => this.teamOperations.reason(id),
      (id) => this.teamActionAvailability(id),
      {
        workspaces: this.teamWorkspaces,
        available: (id) => {
          try {
            this.teamOperations.assertAvailable(id, undefined, { retainedTask: true });
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      },
      (id) => this.threads.update(id, { mode: "act" }),
    );
    this.teamTasks = new TeamTaskService(db, this.teams, invalidate, {
      images: (spec) => new AttachmentService(options.dataDir).forTask(spec),
      review: this.review,
      runs: this.runs,
      enabled: () => this.settings.get().experimentalTeamExecution,
      exportAvailability: taskExport,
      deleteOwner: (id) => this.teamDeletions.ownerDeletion(id),
    });
    this.taskForwarding = new TaskForwardingService(
      db,
      this.teamTasks,
      this.teamOperations,
      this.workspaceWriters,
      this.taskCheckout,
      options.dataDir,
      () => this.settings.get().defaultWorkspaceMode,
      invalidate,
    );
    this.providerUsage = new ProviderUsageService(db, this.system, { apiKey: () => this.memory.credentialStatus() }, () => this.environment.current());
    this.lifecycle = new LifecycleService(db, this.threads, invalidate, this.log);
    this.schedules = new ScheduleService(db, this.threads, invalidate, notify, this.log, {
      maintenance: () => this.agentUpdates.get().updating,
      teams: this.teamConversations,
      teamQuiescenceReason: (id) => this.teamOperations.reason(id),
    });
    this.files = new FileService();
    this.imports = new ImportService(db, this.ledger, invalidate, this.log);
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
  }

  private teamActionAvailability(id: string) {
    const availability = this.review.teamActionAvailability(id);
    const pending = teamForks.pendingForThread(this.db, id)[0];
    const restore = teamRestores.pendingForThread(this.db, id)[0];
    const move = teamMoves.pendingForThread(this.db, id)[0];
    const deleteRecovery = this.teamDeletions.recovery(id);
    return {
      commit: availability,
      push: availability,
      createPr: availability,
      fork: this.teamForks.availability(id),
      restore: this.teamRestores.availability(id),
      move: this.teamMoves.availability(id),
      delete: this.teamDeletions.availability(id),
      ...(deleteRecovery ? { deleteRecovery } : {}),
      ...(move ? { moveRecovery: { requestKey: move.requestKey, to: move.to, error: move.error, cancelRequested: move.cancelRequested } } : {}),
      ...(restore ? { restoreRecovery: { requestKey: restore.requestKey, checkpointId: restore.checkpointId, error: restore.error } } : {}),
      ...(pending ? { forkRecovery: { requestKey: pending.requestKey, upToRunId: pending.upToRunId, error: pending.error } } : {}),
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
    core.teams.recover();
    // Interrupted deletions fence their exact paths before any workspace recovery can touch them.
    await core.teamDeletions.recover();
    await core.teamMoves.recover();
    await core.teamWorkspaces.recover();
    core.teamNotifications.baselineAfterRecovery();
    // Ready means launchable: nothing may be admitted before the login shell has answered once.
    const shell = await core.environment.refresh();
    if (!shell.ok) core.log.warn(`could not read the login shell environment, launching with the app's own: ${shell.error}`);
    const mcp = await core.mcpServer();
    options.transport.push({ type: "ready", pid: process.pid, mcpPort: mcp.port });
    core.lifecycle.start();
    core.schedules.start();
    core.threads.recoverQueue();
    core.upkeep.start();
    if (!options.ephemeral) core.agentUpdates.start();
    // Embed any memories that predate the vector index, off the startup path.
    void core.memory.backfillVectors().catch(() => undefined);
    return core;
  }
  async mcpServer(): Promise<OpenOrcMcpServer> {
    if (!this.mcp) {
      const { assertTeamActor, taskFor, projectFor } = createContextHost({ teams: this.teams, db: this.db });
      this.mcp = startMcpServer({
        ...createRunHost({ runService: this.runs, db: this.db, comments: this.comments, assertTeamActor }),
        ...createBrowserHost({ db: this.db, runService: this.runs, browser: this.options.browser, assertTeamActor }),
        ...createMemoryHost({ memoryService: this.memory, runService: this.runs, db: this.db, assertTeamActor, taskFor, projectFor }),
        ...createTeamHost({ teams: this.teams, slack: this.slack }),
        ...createThreadsHost({ threadService: this.threads, teamConversations: this.teamConversations, db: this.db, assertTeamActor }),
        pullReview: this.pullRequests.agentTools(),
        tasks: {
          ...createTasksHost({ teams: this.teams, threadService: this.threads, teamTasks: this.teamTasks, dataDir: this.options.dataDir, assertTeamActor }),
          create: createTaskCreateHost({ teams: this.teams, teamTasks: this.teamTasks, threadService: this.threads, db: this.db, assertTeamActor }),
        },
      });
    }
    return this.mcp;
  }

  /** Dispatch one renderer request. Never throws; errors go back as rpc.error. */
  async handle(request: RpcRequest): Promise<void> {
    const { id, method } = request;
    const privateParams = method.startsWith("slack.") || method === "memory.settings.set";
    const schema = (rpcParams as Record<string, (typeof rpcParams)[RpcMethod]>)[method];
    if (!schema) {
      this.options.transport.push({ type: "rpc.error", id, message: `unknown method ${method}` });
      return;
    }
    const parsed = schema.safeParse(request.params ?? {});
    if (!parsed.success) {
      this.options.transport.push({
        type: "rpc.error",
        id,
        message: invalidParamsMessage(method, parsed.error.message),
      });
      return;
    }
    try {
      this.guardTeamRequest(method as RpcMethod, parsed.data);
      const handler = this.handlers[method as RpcMethod] as (p: unknown) => Promise<unknown> | unknown;
      const started = Date.now();
      const result = await handler(parsed.data);
      if (process.env["OPENORC_RPC_LOG"] === "1") {
        console.log(`[rpc] ${method} ${privateParams ? "[private]" : JSON.stringify(parsed.data).slice(0, 120)} -> ${resultSummary(result)} in ${Date.now() - started} ms`);
      }
      this.options.transport.push({ type: "rpc.result", id, result: result ?? null });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const message = method.startsWith("slack.") ? redact(detail).text : detail;
      this.log.error(`${method}: ${message}`);
      this.options.transport.push({ type: "rpc.error", id, message });
    }
  }

  /** The proof cannot fall through a model-only lifecycle path and orphan its workers. */
  private guardTeamRequest(method: RpcMethod, value: unknown): void {
    const params = value as Record<string, unknown>;
    const pinned = (id: unknown) => typeof id === "string" && Boolean(orchestration.getInstance(this.db, id));
    const ownedTask = (id: unknown) => typeof id === "string" && Boolean(teamRuntime.assignmentForTask(this.db, id) || pinned(tasks.get(this.db, id)?.threadId));
    // A deleted conversation is reachable only through its saved tasks. Generic
    // thread reads and mutations must not resurrect it; historical file reads stay.
    const hidden = (id: unknown) => typeof id === "string" && teamDeletedThreads.has(this.db, id);
    if (
      ([
        "threads.fork",
        "threads.moveWorkspace",
        "threads.cancelMove",
        "threads.compact",
        "threads.queue",
        "threads.unqueue",
        "threads.sendQueued",
        "threads.checkpoints",
        "threads.turnChanges",
        "threads.restore",
        "threads.send",
      ].includes(method) &&
        hidden(params["id"])) ||
      (["review.threadDiff", "review.commitThread", "review.pushThread", "review.createThreadPr", "review.threadPrTemplate", "git.threadLog", "git.threadPushState", "runs.listForThread"].includes(
        method,
      ) &&
        hidden(params["threadId"]))
    ) {
      throw new Error("This conversation was deleted. Its saved tasks keep their team activity and controls.");
    }
    if (
      [
        "orchestration.turnChanges",
        "orchestration.stop",
        "orchestration.retry",
        "orchestration.compact",
        "orchestration.cancelDirection",
        "orchestration.sendNow",
        "orchestration.implementPlan",
        "orchestration.send",
        "orchestration.configureLead",
        "orchestration.workspace.retrySetup",
        "orchestration.workspace.acceptSetup",
        "orchestration.integration.retry",
        "orchestration.integration.accept",
      ].includes(method)
    ) {
      this.teamConversations.assertTaskScope(params["threadId"] as string, params["taskId"] as string | undefined);
    }
    const taskId = params["taskId"] ?? params["id"];
    const forwarding = typeof taskId === "string" ? (taskForwardings.target(this.db, taskId) ?? taskForwardings.source(this.db, taskId)) : null;
    if (
      forwarding?.state === "preparing" &&
      ["tasks.delete", "tasks.update", "tasks.start", "tasks.prepareWorkspace", "workspace.cleanup", "runs.start", "review.commit", "review.push", "review.createPr"].includes(method)
    ) {
      throw new Error("Finish the saved handoff from the original team task before changing or starting this task.");
    }
    let blocked = false;
    switch (method) {
      case "threads.update": {
        const patch = params["patch"] as Record<string, unknown>;
        blocked = pinned(params["id"]) && ["agent", "model", "effort", "fastMode"].some((key) => patch[key] !== undefined);
        break;
      }
      case "threads.queue":
      case "threads.sendQueued":
        blocked = pinned(params["id"]);
        break;
      case "tasks.start":
      case "tasks.prepareWorkspace":
      case "workspace.cleanup":
        blocked = ownedTask(params["taskId"]);
        break;
      case "review.comments.send":
        blocked = pinned(params["threadId"]) || ownedTask(params["taskId"]);
        break;
      case "tasks.delete":
        blocked = ownedTask(params["id"]);
        break;
      case "runs.start":
        blocked = pinned(params["threadId"]) || ownedTask(params["taskId"]);
        break;
    }
    if (blocked && method === "tasks.delete" && hidden(tasks.get(this.db, params["id"] as string)?.threadId))
      throw new Error("A deleted conversation's saved tasks are deleted together from a task's Details, which also removes the team's remaining workspaces.");
    if (blocked) throw new Error("This team-owned operation is not available in the team execution preview. Its work and history are preserved; use team direction or Stop.");
  }

  /** Called without yielding after the desktop has fenced incoming RPCs. A successful reservation is followed by close(). */
  prepareForUpdate(): string | null {
    if (this.agentUpdates.get().updating) return "Wait for agent updates to finish before restarting.";
    if (this.memory.hasPendingWork) return "Wait for memory processing to finish before restarting to update.";
    if (teamRuntime.openIds(this.db).length) return "Finish or stop your active teams before restarting to update.";
    if (this.schedules.hasPendingWork) return "A scheduled task is starting. Try again when it has finished.";
    if (!this.runs.prepareForUpdate()) return "Wait for agent work, approvals, and context maintenance to finish before restarting to update.";
    this.schedules.stopAccepting();
    return null;
  }

  async close(): Promise<void> {
    this.threads.stopAccepting();
    await this.agentUpdates.close();
    await this.comments.close();
    await this.slack.close();
    this.lifecycle.stop();
    this.reviewerApp.shutdown();
    await this.upkeep.stop();
    this.teamNotifications.shutdown();
    await this.schedules.shutdown();
    await this.teamForks.shutdown();
    await this.teamMoves.shutdown();
    await this.teamDeletions.shutdown();
    await this.taskForwarding.shutdown();
    await this.teamOperations.shutdown();
    await this.teamRestores.shutdown();
    await this.teams.shutdown();
    await this.workspaces.shutdown();
    await this.runs.closeAll();
    await this.threads.shutdown();
    await this.teamWorkspaces.shutdown();
    await this.memory.shutdown();
    this.bench.stop();
    this.ledger.close();
    await this.providerLog.close();
    if (this.mcp) await (await this.mcp).close();
    this.db.close();
  }

  private buildHandlers(invalidate: (keys: string[]) => void): Handlers {
    return composeHandlers(
      createSlackHandlers({ slack: this.slack, invalidate }),
      createSystemHandlers({ system: this.system, agentUpdates: this.agentUpdates, providerUsage: this.providerUsage, invalidate }),
      createProjectsHandlers({ db: this.db, projectService: this.projects, invalidate, transport: this.options.transport }),
      createPullRequestHandlers({ pullRequests: this.pullRequests }),
      createReviewerAppHandlers({ reviewerApp: this.reviewerApp }),
      createOrchestrationHandlers({ orchestrationService: this.orchestration, teamConversations: this.teamConversations, teamTasks: this.teamTasks, db: this.db }),
      createThreadQueriesHandlers({ threadService: this.threads, db: this.db, imports: this.imports }),
      createThreadLaunchHandlers({ threadService: this.threads, teamConversations: this.teamConversations, imports: this.imports }),
      createThreadWorkspaceHandlers({
        db: this.db,
        teamDeletionsService: this.teamDeletions,
        threadService: this.threads,
        upkeep: this.upkeep,
        teamForksService: this.teamForks,
        teamMovesService: this.teamMoves,
        teamRestoresService: this.teamRestores,
      }),
      createThreadMessagesHandlers({ db: this.db, teamConversations: this.teamConversations, threadService: this.threads }),
      createTaskQueriesHandlers({ db: this.db, comments: this.comments, threadService: this.threads, taskForwarding: this.taskForwarding }),
      createTaskCreateHandlers({ db: this.db, settings: this.settings, threadService: this.threads, invalidate, dataDir: this.options.dataDir }),
      createTaskUpdateHandlers({ threadService: this.threads, db: this.db, runService: this.runs, workspaceWriters: this.workspaceWriters, workspaces: this.workspaces, invalidate }),
      createTaskDeleteHandlers({ workspaces: this.workspaces, comments: this.comments, runService: this.runs, db: this.db, log: this.log, upkeep: this.upkeep, invalidate }),
      createWorkspaceHandlers({ runService: this.runs, workspaces: this.workspaces, db: this.db, invalidate }),
      createRunsHandlers({ threadService: this.threads, teams: this.teams, runService: this.runs, db: this.db, dataDir: this.options.dataDir }),
      createAttachmentsHandlers({ db: this.db, dataDir: this.options.dataDir }),
      createEventsHandlers({ frames: this.frames, ledger: this.ledger, db: this.db, runService: this.runs }),
      createMcpAppsHandlers({ runService: this.runs }),
      createReviewThreadHandlers({ review: this.review, db: this.db, invalidate }),
      createReviewCommentsHandlers({ review: this.review, invalidate }),
      createReviewWorkspaceHandlers({ review: this.review, db: this.db, taskCheckout: this.taskCheckout, invalidate }),
      createFilesHandlers({ db: this.db, files: this.files }),
      createSettingsHandlers({ settings: this.settings, textGeneration: this.textGeneration, invalidate }),
      createSchedulesHandlers({ schedules: this.schedules }),
      createCatalogHandlers({ runService: this.runs, invalidate }),
      createMemoryHandlers({ memory: this.memory, db: this.db }),
      createInboxHandlers({ runService: this.runs, db: this.db, teams: this.teams }),
      createBenchHandlers({ frames: this.frames, bench: this.bench, db: this.db, ledger: this.ledger, transport: this.options.transport, benchmarks: Boolean(this.options.benchmarks) }),
    );
  }
}
