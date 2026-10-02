import { randomUUID } from "node:crypto";
import { AcpAdapter, captureLaunchEnvironment, ClaudeAdapter, CodexAdapter, type AgentLaunchEnvironment } from "@openorc/agents";
import { completedToolCall, plans, runs, tasks, type Db, type LedgerWriter } from "@openorc/db";
import { UserInput, type OpenOrcMcpServer, type TaskCard, type UserInputResult } from "@openorc/mcp";
import {
  harnessShortName,
  isHarnessId,
  normalizeModelSettings,
  type AgentEvent,
  type AgentKind,
  type ApprovalDecision,
  type ApprovalResolution,
  type BackgroundCommand,
  type ExecutionMode,
  type HarnessId,
  type ModelCatalog,
  type ModelOption,
  type Project,
  type Run,
  type Thread,
  type ThreadSession,
} from "@openorc/protocol";
import type { FrameCoalescer } from "../frames.js";
import type { Logger } from "../transport.js";
import type { AppAction } from "./app-actions.js";
import { RunApprovals } from "./run-approvals.js";
import { RunBriefs } from "./run-briefs.js";
import { RunCatalog } from "./run-catalog.js";
import { RunEvents } from "./run-events.js";
import { RunLaunch } from "./run-launch.js";
import { RunLive } from "./run-live.js";
import { McpAppService } from "./mcp-apps.js";
import { RunProcess } from "./run-process.js";
import { RunProgress } from "./run-progress.js";
import { isSessionLost, RunSettlement } from "./run-settlement.js";
import { matchesContinueSettings, RunTurns } from "./run-turns.js";
import {
  occupied,
  working,
  type ContinueSettings,
  type LiveRun,
  type Notification,
  type PendingApproval,
  type RunAdapterRegistry,
  type RunHooks,
  type RunScope,
  type SendOptions,
  type StartRunInput,
  type ThreadPermissionState,
  type TurnSettledOutcome,
} from "./run-types.js";
import { workspaceWriters, type WorkspaceWriters } from "./workspace-writers.js";

export type { ContinueSettings, Notification, PendingApproval, RunAdapterRegistry, RunHooks, RunScope, SendOptions, StartRunInput, ThreadPermissionState, TurnSettledOutcome } from "./run-types.js";

export { isSessionLost } from "./run-settlement.js";

export { versionAtLeast } from "./run-catalog.js";

/**
 * Owns live agent processes. Every event goes to the ledger and to the
 * renderer; approvals wait here for the user's answer; each finished turn on
 * a task snapshots the worktree so the review view can show what changed.
 */
export class RunService {
  private agentUpdateReserved = false;
  private pendingSends = 0;

  /** Fence admission before yielding, then retire idle sessions so the next turn resumes on the new binary. */
  async reserveAgentUpdate(): Promise<() => void> {
    if (
      this.agentUpdateReserved ||
      this.closing ||
      this.starting.size ||
      this.startOperations.size ||
      this.pendingSends ||
      this.catalog.pending ||
      this.finalizations.size ||
      this.compactions.size ||
      this.approvals.pendingCount ||
      [...this.live.values()].some((entry) => working(entry) || entry.exiting || entry.closingRequested)
    ) {
      throw new Error("Finish agent work and pending approvals before updating. Your conversations will be kept.");
    }
    if (this.backgroundCommandsRunning) throw new Error("Stop the background commands running in your conversations before updating.");
    this.agentUpdateReserved = true;
    try {
      await Promise.all([...this.live.keys()].map((id) => this.closeAndWait(id)));
      return () => {
        this.agentUpdateReserved = false;
      };
    } catch (error) {
      this.agentUpdateReserved = false;
      throw error;
    }
  }

  private assertAgentUpdateIdle(): void {
    if (this.agentUpdateReserved) throw new Error("An agent update is running. Try again when it finishes.");
  }
  readonly mcpApps = new McpAppService({
    remember: (runId, toolCallId, mcp) => this.emit({ type: "tool.updated", runId, ts: Date.now(), toolCallId, mcp }),
    call: (runId, callId) => {
      this.ledger.flush();
      const call = completedToolCall(this.db, runId, callId);
      // An app receives its tool's result as the tool returned it, images included.
      return call && this.hooks.inlineToolImages ? { ...call, output: this.hooks.inlineToolImages(call.output) } : call;
    },
    connection: (runId) => {
      const entry = this.live.get(runId);
      return entry && !entry.exiting && !entry.closingRequested && entry.run.mode !== "plan" ? entry.handle.mcpApps : undefined;
    },
    approve: async (runId, tool, args, signal) => {
      const approvalId = `mcp-app-${randomUUID()}`;
      const cancel = () => this.approvals.settleApproval(runId, approvalId, { decision: "deny" }, "openorc");
      if (signal.aborted) return false;
      const pending = this.requestApproval(runId, approvalId, tool, args);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await pending;
        this.emit({ type: "approval.resolved", runId, ts: Date.now(), approvalId, decision: result.decision });
        return result.decision !== "deny" && !signal.aborted;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  });
  /** RunLive is the sole owner of the process map; collaborators receive read-only views. */
  private get live(): ReadonlyMap<string, LiveRun> {
    return this.liveView.entries;
  }
  private readonly starting = new Set<string>();
  private readonly startOperations = new Set<Promise<Run>>();
  private readonly finalizations = new Set<Promise<void>>();
  private closing = false;
  private get compactions(): ReadonlyMap<string, Promise<void>> {
    return this.liveView.compactions;
  }
  /**
   * How many agent messages in a row led to each conversation's current work, counted by thread_send. A message
   * from a person, in the app or through Slack or a schedule, resets it. Kept in memory: a restart resets every chain.
   */
  private readonly agentHops = new Map<string, number>();
  /**
   * `own` marks requests the core announced itself, so the core also announces their outcome. `always` marks one no
   * mode answers for the user, such as typing into a password field.
   */
  private readonly approvals: RunApprovals;
  private readonly claude = new ClaudeAdapter({});
  private readonly codex: CodexAdapter;
  private readonly opencode: AcpAdapter;
  private readonly adapters: RunAdapterRegistry;
  private readonly catalog: RunCatalog;
  private readonly briefs: RunBriefs;
  private readonly liveView: RunLive;
  private readonly events: RunEvents;
  private readonly settlement: RunSettlement;
  private readonly launcher: RunLaunch;
  private readonly process: RunProcess;
  private readonly turns: RunTurns;
  private readonly progress: RunProgress;

  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerWriter,
    private readonly frames: FrameCoalescer,
    private readonly mcp: () => Promise<OpenOrcMcpServer>,
    private readonly invalidate: (keys: string[]) => void,
    private readonly log: Logger,
    private readonly hooks: RunHooks,
    adapters?: RunAdapterRegistry,
    private readonly writers: WorkspaceWriters = workspaceWriters,
  ) {
    this.writers.onConflict(
      (paths) => this.liveView.yieldIdle(paths),
      (message) => this.log.info(message),
      (leaseId) =>
        [...this.live.values()].some(
          (entry) => entry.workspaceLease.id === leaseId && entry.scope.thread && !entry.team && !occupied(entry) && !entry.exiting && !entry.closingRequested && !this.compactions.has(entry.run.id),
        ),
    );
    this.codex = new CodexAdapter({ onApproval: (request) => this.approvals.handleCodexApproval(request) });
    this.opencode = new AcpAdapter({ onApproval: (request) => this.approvals.handleOpenCodeApproval(request) });
    this.adapters = adapters ?? { codex: this.codex, claude: this.claude, opencode: this.opencode };
    this.catalog = new RunCatalog(this.hooks, this.codex, this.opencode, () => this.assertAgentUpdateIdle());
    this.briefs = new RunBriefs(this.db, this.hooks);
    this.liveView = new RunLive({
      db: this.db,
      isClosing: () => this.closing,
      isAgentUpdateReserved: () => this.agentUpdateReserved,
      closeAndWait: (runId) => this.closeAndWait(runId),
      hooks: this.hooks,
      emit: (event) => this.emit(event),
      invalidate: this.invalidate,
      keysFor: (scope) => this.keysFor(scope),
      log: this.log,
    });
    this.approvals = new RunApprovals({
      db: this.db,
      live: this.live,
      isClosing: () => this.closing,
      emit: (event) => this.emit(event),
      invalidate: this.invalidate,
      keysFor: (scope) => this.keysFor(scope),
      log: this.log,
    });
    this.settlement = this.createSettlement();
    this.launcher = this.createLauncher();
    this.events = new RunEvents({
      db: this.db,
      log: this.log,
      hooks: this.hooks,
      emit: (event) => this.emit(event),
      invalidate: this.invalidate,
      keysFor: (scope) => this.keysFor(scope),
      denyApprovals: (runId) => this.approvals.denyApprovals(runId),
      canSteer: (runId) => this.canSteer(runId),
      disarmIdle: (runId) => this.liveView.disarmIdle(runId),
      armIdle: (entry) => this.liveView.armIdle(entry),
      refreshDiffs: (entry, project) => this.liveView.refreshDiffs(entry, project),
      completeTurn: (entry, project, turn) => this.settlement.completeTurn(entry, project, turn),
    });
    this.process = new RunProcess({
      db: this.db,
      log: this.log,
      attach: (entry) => this.liveView.attach(entry),
      finalizations: this.finalizations,
      denyApprovals: (runId) => this.approvals.denyApprovals(runId),
      watchDiffs: (entry, project) => this.liveView.watchDiffs(entry, project),
      publishProviderEvent: (entry, event) => this.events.publishProviderEvent(entry, event),
      onEvent: (entry, project, event) => this.events.onEvent(entry, project, event),
      onExit: (entry, project) => this.settlement.onExit(entry, project),
    });
    this.turns = new RunTurns({
      db: this.db,
      live: this.live,
      compactions: this.compactions,
      isClosing: () => this.closing,
      hooks: this.hooks,
      resetAgentChain: (id) => this.agentHops.delete(id),
      disarmIdle: (runId) => this.liveView.disarmIdle(runId),
      armIdle: (entry) => this.liveView.armIdle(entry),
      invalidate: this.invalidate,
      keysFor: (scope) => this.keysFor(scope),
      start: (input) => this.start(input),
      emit: (event) => this.emit(event),
      validateFastMode: (agent, model, fastMode) => this.validateFastMode(agent, model, fastMode),
      log: this.log,
    });
    this.progress = new RunProgress(this.db, this.ledger, this.live, () => this.pending());
  }

  private createSettlement(): RunSettlement {
    return new RunSettlement({
      db: this.db,
      ledger: this.ledger,
      log: this.log,
      hooks: this.hooks,
      mcp: this.mcp,
      mcpApps: this.mcpApps,
      detach: (runId) => this.liveView.detach(runId),
      isClosing: () => this.closing,
      invalidate: this.invalidate,
      keysFor: (scope) => this.keysFor(scope),
      notifyFor: (scope, kind, title, body) => this.notifyFor(scope, kind, title, body),
      scopeTitle: (scope) => this.scopeTitle(scope),
      turnSettled: (run, scope, project, outcome) => this.turnSettled(run, scope, project, outcome),
      armIdle: (entry) => this.liveView.armIdle(entry),
      refreshDiffs: (entry, project) => this.liveView.refreshDiffs(entry, project),
      disarmIdle: (runId) => this.liveView.disarmIdle(runId),
      endDiffRefresh: (runId, ended) => this.liveView.endDiffRefresh(runId, ended),
      denyApprovals: (runId) => this.approvals.denyApprovals(runId),
    });
  }

  private createLauncher(): RunLaunch {
    return new RunLaunch({
      db: this.db,
      ledger: this.ledger,
      mcp: this.mcp,
      writers: this.writers,
      adapters: this.adapters,
      hooks: this.hooks,
      log: this.log,
      isClosing: () => this.closing,
      live: this.live,
      emit: (event) => this.emit(event),
      invalidate: this.invalidate,
      keysFor: (scope) => this.keysFor(scope),
      notifyFor: (scope, kind, title, body) => this.notifyFor(scope, kind, title, body),
      closeAndWait: (runId) => this.closeAndWait(runId),
      bindLiveProcess: (binding) => this.process.bindLiveProcess(binding),
      applyThreadPermissions: (thread) => this.applyThreadPermissions(thread),
      turnSettled: (run, scope, project, outcome) => this.turnSettled(run, scope, project, outcome),
      taskBrief: (task, project, mode, teamManaged) => this.briefs.taskBrief(task, project, mode, teamManaged),
      threadBrief: (thread, project, mode) => this.briefs.threadBrief(thread, project, mode),
      models: (agent, environment, launch) => this.models(agent, environment, launch),
      validateFastMode: (agent, model, fastMode, environment, launch) => this.validateFastMode(agent, model, fastMode, environment, launch),
      liveRunForTask: (id) => this.liveRunForTask(id),
      liveRunForThread: (id) => this.liveRunForThread(id),
    });
  }

  requestApproval(runId: string, approvalId: string, toolName: string, input: unknown): Promise<ApprovalResolution> {
    return this.approvals.requestApproval(runId, approvalId, toolName, input);
  }

  acceptsPlanWrite(runId: string): boolean {
    return this.approvals.acceptsPlanWrite(runId);
  }

  writePlan(runId: string, text: string): void {
    this.approvals.writePlan(runId, text);
  }

  requestUserInput(runId: string, requestId: string, rawInput: UserInput, signal?: AbortSignal): Promise<UserInputResult> {
    return this.approvals.requestUserInput(runId, requestId, rawInput, signal);
  }

  authorizeAppAction(runId: string, action: AppAction, request: { toolName: string; reason: string; input: unknown }, receiver?: ExecutionMode): Promise<void> {
    return this.approvals.authorizeAppAction(runId, action, request, receiver);
  }

  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision, answers?: Record<string, string[]>): void {
    this.approvals.resolveApproval(runId, approvalId, decision, answers);
  }

  assertThreadPermissions(threadId: string): void {
    this.approvals.assertThreadPermissions(threadId);
  }

  threadPermissions(threadId: string): ThreadPermissionState {
    return this.approvals.threadPermissions(threadId);
  }

  applyThreadPermissions(thread: Thread): ThreadPermissionState {
    return this.approvals.applyThreadPermissions(thread);
  }

  pending(): PendingApproval[] {
    return this.approvals.pending();
  }

  /** The live run on a task, if any, so review comments can continue a conversation. */
  liveRunForTask(taskId: string): Run | null {
    for (const entry of this.live.values()) if (entry.run.taskId === taskId) return entry.run;
    return null;
  }

  liveRunForThread(threadId: string): Run | null {
    for (const entry of this.live.values()) if (entry.run.threadId === threadId) return entry.run;
    return null;
  }

  /**
   * What a thread is doing right now, for its card in the sidebar. Background work counts after the turn that started
   * it ends; a command left running, such as a dev server, does not.
   */
  threadActivity(threadId: string): "idle" | "running" | "waiting" {
    const entry = [...this.live.values()].find((e) => e.run.threadId === threadId);
    if (!entry) return "idle";
    for (const p of this.approvals.pendingEntries) if (p.info.runId === entry.run.id) return "waiting";
    return working(entry) ? "running" : "idle";
  }

  /** Commands the thread's agent left running in the background, such as a dev server. */
  threadBackgroundCommands(threadId: string): BackgroundCommand[] {
    return [...this.live.values()].find((e) => e.run.threadId === threadId)?.commands ?? [];
  }

  /** Stop a command the thread's agent left running. One that already ended is left alone. */
  async stopBackgroundCommand(threadId: string, commandId: string): Promise<void> {
    const entry = [...this.live.values()].find((e) => e.run.threadId === threadId);
    if (!entry?.commands.some((command) => command.id === commandId)) return;
    await entry.handle.stopCommand(commandId);
  }

  /** An agent left a command running in the background. Closing its process for an update would end it. */
  get backgroundCommandsRunning(): boolean {
    return [...this.live.values()].some((entry) => entry.commands.length > 0);
  }

  /** The state of the provider session behind a thread, from the live process or the last run's fate. */
  threadSession(threadId: string): ThreadSession {
    const live = this.liveRunForThread(threadId);
    if (live) return { status: "live", message: null };
    const last = runs.listForThread(this.db, threadId).at(-1);
    if (!last || last.state !== "error") return { status: "idle", message: null };
    return { status: isSessionLost(last.error) ? "lost" : "error", message: last.error };
  }

  /**
   * When the agent on this run last produced an event, epoch ms, for detecting
   * a run that has gone quiet. Falls back to the run's start until the first
   * event arrives, so a provider that hung before saying anything still ages.
   * Null when the run is not live: a run nobody is attached to cannot stall.
   */
  lastAgentEventAt(runId: string): number | null {
    const entry = this.live.get(runId);
    return entry ? (entry.lastAgentEventAt ?? entry.run.startedAt) : null;
  }

  /** The same, for the run attached to a thread. Null when the thread has no live run. */
  threadLastAgentEventAt(threadId: string): number | null {
    for (const entry of this.live.values()) if (entry.run.threadId === threadId) return entry.lastAgentEventAt ?? entry.run.startedAt;
    return null;
  }

  /** How full the conversation is, from the latest usage the agent reported. */
  threadContext(threadId: string): { used: number; window: number | null } | null {
    const live = [...this.live.values()].find((e) => e.run.threadId === threadId);
    const usage = live?.usage ?? runs.listForThread(this.db, threadId).at(-1)?.usage ?? null;
    if (!usage || usage.contextTokens === undefined) return null;
    return { used: usage.contextTokens, window: usage.contextWindow ?? null };
  }

  /**
   * Runs the previous app instance left open never got their exit. Mark them
   * so the thread shows what happened instead of a session that looks alive.
   */
  recoverInterrupted(): void {
    for (const run of runs.listUnfinished(this.db)) {
      this.emit({ type: "session.completed", runId: run.id, ts: Date.now(), status: "error", durationMs: Math.max(0, Date.now() - run.startedAt) });
      runs.update(this.db, run.id, { state: "error", endedAt: Date.now(), error: "OpenOrc closed while this session was open. Send a message to continue where you left off." });
      if (run.taskId) {
        const task = tasks.get(this.db, run.taskId);
        if (task?.status === "in_progress") tasks.update(this.db, task.id, { status: "review" });
      }
    }
  }

  canCompact(runId: string): boolean {
    return Boolean(this.live.get(runId)?.handle.canCompact);
  }

  /** Ask the live agent to summarise its context in place: Codex through app-server, Claude through its /compact command. */
  compact(runId: string): Promise<void> {
    return this.liveView.compact(runId);
  }

  /** Keep the original array interface for execution and automation callers. */
  async models(agent?: AgentKind, environment = this.hooks.environment(), admitted?: AgentLaunchEnvironment): Promise<ModelOption[]> {
    if (agent && !isHarnessId(agent)) return [];
    return (await this.modelCatalog(agent, false, environment, admitted)).models;
  }

  modelCatalog(agent?: HarnessId, refresh = false, environment = this.hooks.environment(), admitted?: AgentLaunchEnvironment): Promise<ModelCatalog> {
    return this.catalog.modelCatalog(agent, refresh, environment, admitted);
  }

  async validateFastMode(agent: AgentKind, model: string | undefined, fastMode: boolean | undefined, environment = this.hooks.environment(), launch?: AgentLaunchEnvironment): Promise<void> {
    if (!fastMode) return;
    const options = await this.models(agent, environment, launch);
    const selected = model ? options.find((m) => m.id === model) : options.find((m) => m.isDefault);
    if (!selected?.fastMode?.supported || selected.unavailable) {
      throw new Error(
        selected?.unavailable ??
          selected?.fastMode?.reason ??
          (selected?.fastMode ? "Fast mode is unavailable for this model." : "Fast mode support has not been confirmed for this model. Try Refresh models."),
      );
    }
  }

  /** Keep an admitted thread recoverable when setup fails before a provider run exists. */
  recordStartFailure(thread: Thread, input: { prompt: string; attachments?: string[] | undefined; promptRole?: "user" | "system" }, error: unknown): void {
    this.launcher.recordStartFailure(thread, input, error);
  }

  /** The number of agent messages in a row behind a conversation's current work. */
  agentChain(threadId: string): number {
    return this.agentHops.get(threadId) ?? 0;
  }

  /** Records that an agent message, `hops` deep in a chain, reached a conversation. */
  noteAgentMessage(threadId: string, hops: number): void {
    this.agentHops.set(threadId, hops);
  }

  async start(input: StartRunInput): Promise<Run> {
    this.assertAgentUpdateIdle();
    input = normalizeModelSettings(input);
    // Team actors can start fresh provider sessions for agent-directed work. Only
    // the team's human input boundary may reset its cross-conversation chain.
    if (!input.teamAttemptId && (input.promptRole ?? "user") === "user" && input.scope.thread) this.agentHops.delete(input.scope.thread.id);
    if (this.closing) throw new Error("OpenOrc is closing.");
    this.hooks.assertStart?.(input);
    if (!isHarnessId(input.agent)) throw new Error(`Provider ${input.agent} has no executable adapter.`);
    input.assertCanStart?.();
    const environment = this.hooks.environment();
    const launch = captureLaunchEnvironment(input.agent, environment);
    const key = this.startKey(input);
    if (this.starting.has(key)) throw new Error("This conversation is already starting. Wait for it to connect before sending again.");
    this.starting.add(key);
    const operation = this.launcher.startSession(input, environment, launch);
    this.startOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.starting.delete(key);
      this.startOperations.delete(operation);
    }
  }

  private startKey(input: StartRunInput): string {
    if (input.scope.comment) return `comment:${input.scope.comment.id}`;
    if (input.scope.thread) return `thread:${input.scope.thread.id}${input.shared ? `:${input.shared.key}` : ""}`;
    return `task:${input.scope.task.id}`;
  }

  canSteer(runId: string): boolean {
    const entry = this.live.get(runId);
    return !this.closing && Boolean(entry && entry.busy && !entry.exiting && !entry.closingRequested && !entry.failed && !this.compactions.has(runId) && entry.handle.canSteer);
  }

  steerUnavailableReason(runId: string): string | null {
    const entry = this.live.get(runId);
    if (!entry || entry.exiting || entry.closingRequested || entry.failed || this.closing) return "The provider is unavailable. Input is retained for the next turn.";
    if (this.compactions.has(runId) || entry.handle.compacting) return "The provider is compacting context. Input will follow when it is ready.";
    if (!entry.busy) return "The provider is between turns. Input is retained for the next turn.";
    if (!entry.handle.canSteer) return "The provider is starting or cannot accept live input. Input is retained until it is ready.";
    return null;
  }

  /** Internal coordinator transport. Its durable mailbox owns admission and history. */
  steer(runId: string, text: string, attachments?: string[]): Promise<"accepted" | "unavailable"> {
    if (!this.canSteer(runId)) return Promise.resolve("unavailable");
    // No await before invocation: a turn ending here must never fall back to
    // send(), which can start work or replace an idle session's settings.
    return this.live.get(runId)!.handle.steer(text, attachments);
  }

  /** Position canonical mailbox direction among this run's streamed activity. */
  recordTeamDirection(runId: string, input: { id: string; text: string; attachments?: string[] }): void {
    const entry = this.live.get(runId);
    if (!entry) throw new Error("The direction's provider run is no longer live.");
    const messageId = `team-direction:${input.id}`;
    this.ledger.flush();
    if (
      this.db
        .stmt(
          "SELECT 1 FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload' WHERE e.run_id = ? AND e.kind = 'message.completed' AND json_extract(COALESCE(a.content, e.payload), '$.messageId') = ? LIMIT 1",
        )
        .get(runId, messageId)
    )
      return;
    this.emit({ type: "message.completed", runId, ts: Date.now(), messageId, role: "user", text: input.text, ...(input.attachments?.length ? { attachments: input.attachments } : {}) });
    this.ledger.flush();
    this.invalidate(this.keysFor(entry.scope));
  }

  async send(runId: string, text: string, options: SendOptions = {}): Promise<void> {
    this.assertAgentUpdateIdle();
    this.pendingSends++;
    try {
      await this.turns.sendTurn(runId, text, options);
    } finally {
      this.pendingSends--;
    }
  }

  /** The thread asks for something its process was spawned with: agent, mode or permissions. Only a new process can serve it. */

  /**
   * Bring an idle process up to the thread's model, effort and speed without replacing it. Resolves false when the
   * provider cannot take the change, or effort is being reset, so the caller restarts with the new settings.
   * Fast is checked against the account and model first, as a restart would check it.
   */

  async interrupt(runId: string): Promise<void> {
    const entry = this.live.get(runId);
    if (entry) entry.questionsInterrupted = true;
    this.approvals.denyApprovals(runId);
    await this.live.get(runId)?.handle.interrupt();
  }

  /** Persist first so a report survives parent-provider failure or Plan mode. */
  postThreadNotice(threadId: string, messageId: string, text: string): boolean {
    this.ledger.flush();
    const exists = this.db
      .stmt("SELECT 1 FROM events WHERE run_id IN (SELECT id FROM runs WHERE thread_id = ?) AND kind = 'message.completed' AND json_extract(payload, '$.messageId') = ? LIMIT 1")
      .get(threadId, messageId);
    const parent = runs.listForThread(this.db, threadId).at(-1);
    if (exists || !parent) return false;
    this.emit({ type: "message.completed", runId: parent.id, ts: Date.now(), messageId, role: "system", text });
    this.ledger.flush();
    this.invalidate(["threads", `thread:${threadId}`, `runs:thread:${threadId}`]);
    return true;
  }

  /** Bounded, redacted ledger projection shared with the parent agent's MCP tools. */
  taskProgress(taskId: string): TaskCard["activity"] {
    return this.progress.taskProgress(taskId);
  }

  close(runId: string): void {
    const entry = this.live.get(runId);
    if (entry) entry.closingRequested = true;
    this.approvals.denyApprovals(runId);
    this.live.get(runId)?.handle.close();
  }

  /** Retain the live entry on timeout: a requested stop is not proof the process has exited. */
  async closeAndWait(runId: string, timeoutMs = 10_000): Promise<void> {
    const entry = this.live.get(runId);
    if (!entry) return;
    this.liveView.disarmIdle(runId);
    entry.closingRequested = true;
    this.approvals.denyApprovals(runId);
    let signalError: Error | null = null;
    try {
      entry.handle.close();
    } catch (error) {
      signalError = error instanceof Error ? error : new Error(String(error));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A naturally exiting process group may reject a concurrent signal.
      // Completion still requires physical closure and durable finalization.
      await Promise.race([
        Promise.all([entry.handle.wait(), entry.finalized]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Run ${runId} is still closing. Its process or finalization has not finished.`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (signalError) throw new Error(`${signalError.message}; ${error instanceof Error ? error.message : String(error)}`, { cause: signalError });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  /** A turn is in flight on this process. Live alone only means the session is open between turns. */
  isBusy(runId: string): boolean {
    return this.live.get(runId)?.busy === true;
  }

  /**
   * Whether a live process can take another turn as it stands. Everything the process was spawned with is fixed for
   * its lifetime, so a turn that needs different settings needs its own process.
   */
  canContinue(runId: string, desired: ContinueSettings): boolean {
    const entry = this.live.get(runId);
    if (!entry || this.closing || this.compactions.has(runId)) return false;
    if (entry.busy || entry.exiting || entry.closingRequested || entry.failed) return false;
    return matchesContinueSettings(entry, desired);
  }

  /** Atomically refuse a restart or fence new turns before the caller begins shutdown. */
  prepareForUpdate(): boolean {
    if (this.agentUpdateReserved) return false;
    if (this.closing || this.starting.size || this.startOperations.size || this.finalizations.size || this.compactions.size || this.approvals.pendingCount) return false;
    if ([...this.live.values()].some((entry) => occupied(entry) || entry.exiting || entry.closingRequested)) return false;
    this.closing = true;
    return true;
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    this.liveView.stopRefreshes();
    await Promise.allSettled([...this.startOperations]);
    for (const pending of [...this.approvals.pendingEntries]) this.approvals.settleApproval(pending.info.runId, pending.info.approvalId, { decision: "deny" }, "openorc");
    const handles = [...this.live.values()].map((entry) => entry.handle);
    for (const handle of handles) handle.close();
    await Promise.all(handles.map((handle) => handle.wait()));
    await Promise.all([...this.finalizations]);
  }

  private emit(ev: AgentEvent): void {
    ev = { ...ev, eventId: ev.eventId ?? randomUUID() };
    const planRun = this.live.get(ev.runId)?.run ?? runs.get(this.db, ev.runId);
    if (planRun && plans.capture(this.db, planRun, ev)) this.invalidate([`plans:${planRun.threadId}`]);
    this.ledger.push(ev);
    // The renderer draws normalized events only; the ledger hands native payloads to the provider log.
    if (ev.type !== "raw") this.frames.push(ev);
    try {
      this.hooks.onEvent?.(ev);
    } catch {
      this.log.warn("An event subscriber failed; the local agent continues.");
    }
    if (ev.type === "approval.requested") this.notifyApprovalRequested(ev);
  }

  private notifyApprovalRequested(ev: Extract<AgentEvent, { type: "approval.requested" }>): void {
    // Host permission requests enter here outside the provider event queue.
    try {
      this.hooks.onApprovalRequested?.(ev);
      const entry = this.live.get(ev.runId);
      if (!entry || !this.approvals.hasPending(ev.runId, ev.approvalId)) return;
      const question = ev.kind === "user_input";
      const input = (ev.input ?? {}) as Record<string, unknown>;
      let what: string;
      if (question) what = "has a question";
      else if (typeof input["command"] === "string") what = `wants to run ${input["command"]}`;
      else what = `wants to use ${ev.toolName ?? ev.kind}`;
      this.notifyFor(entry.scope, question ? "question" : "approval", this.scopeTitle(entry.scope), `${harnessShortName(entry.run.agent)} ${what}`);
    } catch (error) {
      this.log.warn(`approval notification failed: ${String(error)}`);
    }
  }

  private keysFor(scope: RunScope): string[] {
    if (scope.comment) return [`task-comments:${scope.comment.task.id}`];
    if (scope.task) return ["tasks", "inbox", `task:${scope.task.id}`, `runs:${scope.task.id}`, ...(scope.task.threadId ? ["threads", `thread:${scope.task.threadId}`] : [])];
    return ["threads", `thread:${scope.thread.id}`, `runs:thread:${scope.thread.id}`, "inbox"];
  }

  private notifyFor(scope: RunScope, kind: Notification["kind"], title: string, body: string): void {
    let threadId: string | null;
    if (scope.comment) threadId = null;
    else if (scope.thread) threadId = scope.thread.id;
    else threadId = scope.task.threadId;
    this.hooks.notify({ kind, threadId, taskId: scope.comment?.task.id ?? scope.task?.id ?? null, title, body });
  }

  private scopeTitle(scope: RunScope): string {
    if (scope.comment) return scope.comment.task.title;
    if (scope.task) return scope.task.title;
    return scope.thread.title;
  }

  private turnSettled(run: Run, scope: RunScope, project: Project, outcome: TurnSettledOutcome): void {
    if (!this.hooks.onTurnSettled) return;
    this.ledger.flush();
    try {
      this.hooks.onTurnSettled?.(runs.get(this.db, run.id) ?? run, scope, project, outcome);
    } catch (error) {
      this.log.error(`turn-settled hook failed: ${String(error)}`);
    }
  }
}
