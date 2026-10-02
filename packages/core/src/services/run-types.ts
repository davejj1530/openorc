import type { AgentLaunchEnvironment, RunHandle } from "@openorc/agents";
import type { AgentEvent, AgentKind, BackgroundCommand, CorePush, HarnessId, PermissionPreset, Project, Run, RunMode, RunSpec, Task, TeamPermissionState, Thread, Usage } from "@openorc/protocol";
import type { AppAction } from "./app-actions.js";
import type { EnvSnapshot } from "./shell-environment.js";
import type { WorkspaceLease } from "./workspace-writers.js";

/** A run executes a task in its worktree, or a thread's turn in the project root. */
export type RunScope =
  { task: Task; thread: null; comment?: never } | { task: null; thread: Thread; comment?: never } | { task: null; thread: null; comment: { id: string; task: Task; resumeRunId?: string } };

/** One adapter per registry harness. Execution is injectable; model discovery still uses the installed provider catalogs. */
export type RunAdapterRegistry = Record<HarnessId, { start(spec: RunSpec, launch: AgentLaunchEnvironment): RunHandle }>;

export interface SendOptions {
  role?: "user" | "system";
  attachments?: string[];
  recordPrompt?: boolean;
  /** A team turn the coordinator reserved. Sends to a team run are refused without one. */
  teamAttemptId?: string;
  /** Called once the provider has taken the input, with the run and the process's turn index. Throwing closes the process. */
  onAccepted?: (run: Run, processTurn: number) => void;
}

/** What a process was spawned with, and therefore what a further turn on it must also want. */
export interface ContinueSettings {
  agent: string;
  model?: string | null;
  effort?: string | null;
  fastMode?: boolean;
  mode: RunMode;
  permissionMode: PermissionPreset;
}

export interface TurnSettledOutcome {
  status: "success" | "error" | "cancelled";
  snapshotId: string | null;
  error: string | null;
  /** The provider's own turn status, before the workspace capture weighed in. */
  turnStatus?: "success" | "error" | "cancelled";
  /** Why no snapshot was taken after a turn that otherwise finished; null when the capture succeeded or never ran. */
  captureError?: string | null;
}

export type CompletedTurn = Extract<AgentEvent, { type: "turn.completed" }>;
export type TurnCapture = { snapshotId: string | null; error: string | null };

/** A provider cancellation stays a cancellation even if the process also reported an error. */
export function providerTurnStatus(turn: CompletedTurn, failure: string | null): TurnSettledOutcome["status"] {
  if (turn.status === "cancelled") return "cancelled";
  if (turn.status === "success" && !failure) return "success";
  return "error";
}

/** Keep the provider's result separate from a snapshot/checkpoint failure. */
export function capturedTurnOutcome(turn: CompletedTurn, failure: string | null, capture: TurnCapture): TurnSettledOutcome {
  const turnStatus = providerTurnStatus(turn, failure);
  return {
    status: turnStatus === "success" && capture.error ? "error" : turnStatus,
    snapshotId: capture.snapshotId,
    error: failure ?? capture.error,
    turnStatus,
    captureError: capture.error,
  };
}

export interface StartRunInput {
  scope: RunScope;
  project: Project;
  agent: AgentKind;
  model: string | undefined;
  effort?: string | undefined;
  fastMode?: boolean | undefined;
  attachments?: string[];
  mode: RunMode;
  permissionMode: PermissionPreset;
  prompt: string;
  /** How the prompt shows in the transcript: what the user typed, or a system notice such as a task result. */
  promptRole?: "user" | "system";
  /** A delivered task report may already be visible in the thread ledger. */
  recordPrompt?: boolean;
  resume: boolean;
  /** Where the session to resume comes from, when it is not this scope's own last session (a fork continues its parent's). */
  resumeFrom?: { sessionId: string; fork: boolean };
  /** What the previous agent on this thread knew, for a run that switches provider. */
  handoff?: string;
  /** Bind durable coordination identity before MCP or provider startup can expose tools. */
  onCreated?: (run: Run) => void;
  /** Revalidate admission after asynchronous preparation and immediately before launch. */
  assertCanStart?: () => void;
  systemPromptAppendix?: string;
  /** Captured coordinator attachments can replace live task-document image discovery. */
  collectTaskImages?: boolean;
  /** Internal coordination identity; never accepted from a renderer/model request. */
  teamAttemptId?: string;
  /** Internal setup-to-run handoff, never supplied by a renderer or provider. */
  workspaceLease?: WorkspaceLease;
  /** A team member talking in the conversation: runs beside the thread's other live members in a shared workspace lease. */
  shared?: { key: string };
}

export interface LiveRun {
  questionsInterrupted?: boolean;
  run: Run;
  internalMcp: NonNullable<RunSpec["internalMcp"]>;
  /** Native permissions remain fixed until resume; OpenOrc can allow requests immediately. */
  providerPermissionMode: PermissionPreset;
  /** A stricter team request immediately closes the app gate, even if native bypass needs restart. */
  permissionGate?: PermissionPreset;
  /** App actions the user allowed for the rest of this run. */
  appActionsAllowed?: Set<AppAction>;
  scope: RunScope;
  handle: RunHandle;
  workspaceLease: WorkspaceLease;
  usage: Usage | null;
  turns: number;
  /** A turn is in progress. Sessions stay open between turns, so live alone does not mean working. */
  busy: boolean;
  /** Background work the agent started, such as a subagent or workflow. It outlives turns and reports back in a turn of its own. */
  background: number;
  /** Commands the agent left running in the background, such as a dev server. They run until they end or are stopped. */
  commands: BackgroundCommand[];
  /** Last advertised native control state, independent of transcript output. */
  steerable: boolean;
  /** Stamped when OpenOrc observes the latest provider event. */
  lastAgentEventAt: number | null;
  /** The user's latest message and the agent's latest reply, for naming the thread after its first exchange. */
  prompt: string | null;
  reply: string | null;
  /** The provider announced its session. Without it, a run that exits early never had one. */
  started: boolean;
  /** The coordinator owns a team attempt's process lifetime and workspace lease. */
  team: boolean;
  stderr: string[];
  failed: string | null;
  events: Promise<void>;
  finalized: Promise<void>;
  finishFinalization: () => void;
  failFinalization: (error: unknown) => void;
  exiting: boolean;
  closingRequested: boolean;
}

/** Values settled before the writer lease is acquired; no process or lease is owned yet. */
export interface PreparedSession {
  input: StartRunInput;
  taskImages: string[];
  cwd: string;
  runId: string;
  model: string | undefined;
  resumeSessionId: string | null | undefined;
  forkSession: boolean;
}

export interface LiveProcessBinding {
  run: Run;
  input: StartRunInput;
  handle: RunHandle;
  workspaceLease: WorkspaceLease;
  internalMcp: NonNullable<RunSpec["internalMcp"]>;
  providerPermissionMode: PermissionPreset;
  permissionGate?: PermissionPreset;
}

/** A turn in flight, or background work that will report back: the agent is at work. */
export function working(entry: LiveRun): boolean {
  return entry.busy || entry.background > 0;
}

/** The agent is at work, or a command it left running in the background still runs. Closing the process would end them. */
export function occupied(entry: LiveRun): boolean {
  return working(entry) || entry.commands.length > 0;
}

export interface PendingApproval {
  runId: string;
  taskId: string | null;
  threadId: string | null;
  approvalId: string;
  detail: string;
}

export type ThreadPermissionState = TeamPermissionState;
export type Notification = Extract<CorePush, { type: "notify" }>;

export interface RunHooks {
  processRegistry?: string;
  browserAvailable?: boolean;
  /** Domain events, including host-generated approvals. */
  onEvent?(event: AgentEvent): void;
  /** The environment a run is admitted with, captured synchronously at admission. Required: there is no other source. */
  environment(): EnvSnapshot;
  /** Team checkpoints preserve retained inherited paths even after ignore rules change. */
  captureTeamTree?(runId: string, cwd: string, lease: WorkspaceLease): Promise<string | null>;
  assertStart?(input: StartRunInput): void;
  assertSend?(runId: string, teamAttemptId: string | undefined): void;
  taskImages?(spec: string): Promise<string[]>;
  /** A tool output from the ledger with its stored images inlined again. */
  inlineToolImages?(output: unknown): unknown;
  onProviderEvent?(event: AgentEvent): void;
  onSteerable?(runId: string): void;
  /** Includes host-generated Codex/Claude requests, after their pending handle exists. */
  onApprovalRequested?(event: Extract<AgentEvent, { type: "approval.requested" }>): void;
  brief(project: Project): string;
  /** Instructions that belong to one conversation, such as the pull request it reviews; null for none. */
  threadContext?(thread: Thread): string | null;
  /** Whether a conversation works in a checkout of code the user hasn't vetted, such as a pull request it reviews. */
  untrustedCheckout?(thread: Thread): boolean;
  memoryEnabled?(): boolean;
  onRunFinished(run: Run, scope: RunScope, project: Project): void;
  /** Synchronous notification after capture; consumers queue follow-up work instead of awaiting it here. */
  onTurnSettled?(run: Run, scope: RunScope, project: Project, outcome: TurnSettledOutcome): void;
  /** A thread turn ended: the user's message and what the agent replied. */
  onThreadTurn(thread: Thread, exchange: { prompt: string | null; reply: string | null }): void;
  /** A thread's process went idle without a turn ending, such as background work the user stopped. */
  onThreadIdle?(thread: Thread): void;
  /** Something the user would want to hear about while looking elsewhere. */
  notify(n: Omit<Notification, "type">): void;
  /** The installed Claude Code version string, or null when it is missing. */
  claudeVersion(environment?: EnvSnapshot, env?: Readonly<NodeJS.ProcessEnv>): Promise<string | null>;
  /** How long a thread process may wait idle between turns before it is closed; null keeps it. Read when a turn ends. */
  idleTimeoutMs?(): number | null;
  /** Whether Claude Code should also connect the user's own MCP servers; each one adds to its start-up time. */
  claudeUserMcpServers?(): boolean;
}
