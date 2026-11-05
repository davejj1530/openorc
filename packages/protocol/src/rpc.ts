import { z } from "zod";
import type { AgentUpdates } from "./agent-updates.js";
import { ClaudeAccountId, claudeAccountRpcParams, type ClaudeAccountRpcResults } from "./claude-accounts.js";
import { cloudRpcParams, type CloudRpcResults } from "./cloud.js";
import { codeExplanationRpcParams, type CodeExplanationRpcResults } from "./code-explanations.js";
import { editorRpcParams, type EditorRpcResults } from "./code-intelligence.js";
import { DevicePanelPush, devicePanelRpcParams, type DevicePanelRpcResults } from "./devices.js";
import {
  AgentSkill,
  AppSettings,
  Commit,
  FileChange,
  ImportableSession,
  type InstructionFile,
  Memory,
  MemorySource,
  MemoryStatus,
  MemoryType,
  PermissionPreset,
  PushState,
  QueuedMessage,
  ReviewComment,
  Run,
  RunMode,
  Schedule,
  type ScheduleRunResult,
  SessionSummary,
  Snapshot,
  Task,
  TaskPriority,
  TaskStatus,
  Thread,
  ThreadCheckpoint,
  ThreadMessage,
  ThreadSearchHit,
  ThreadSummary,
  type TurnFileChanges,
  WorkspaceMode,
} from "./domain.js";
import { AgentEvent, AgentKind, ApprovalDecision, Frame } from "./events.js";
import type { ConversationPlan } from "./execution-mode.js";
import { fileRpcParams, type FileRpcResults } from "./files.js";
import { type HarnessAvailability, HarnessId, type HarnessInfo } from "./harness.js";
import type { McpAppOpenResult } from "./mcp-apps.js";
import { ExecutionTarget } from "./execution-target.js";
import { orclingRpcParams, type OrclingRpcResults } from "./orclings.js";
import { previewRpcParams, type PreviewRpcResults } from "./preview.js";
import { projectRpcParams, type ProjectRpcResults } from "./projects.js";
import { BranchName, pullRequestRpcParams, type PullRequestRpcResults } from "./pull-requests.js";
import { remoteRpcParams, type RemoteRpcResults } from "./remote.js";
import { slackRpcParams, type SlackStatus } from "./slack.js";
import type { TaskCheckoutState } from "./task-checkout.js";
import { type CommentAttempt, CommentRecipient, type TaskComment, type TaskDiscussion } from "./task-comments.js";
import { ThreadListParams } from "./thread-list.js";
import { ThreadStartParams } from "./thread-start.js";
import { BranchLoss, type ChangePreview, type FileDiff, type RemovalImpact, workspaceChangeRpcParams, type WorkspaceChanges } from "./workspace-changes.js";

/**
 * Renderer to core RPC. Params are validated in the core; results are typed
 * but trusted. One method map keeps both sides honest.
 */

const reviewCommentScope = { threadId: z.string().min(1).optional(), taskId: z.string().min(1).optional() };
const hasReviewScope = (scope: { threadId?: string; taskId?: string }) => Boolean(scope.threadId || scope.taskId);
const REVIEW_SCOPE_REQUIRED = "Review comments need a conversation or a task.";

export const rpcParams = {
  ...claudeAccountRpcParams,
  ...slackRpcParams,
  ...pullRequestRpcParams,
  ...orclingRpcParams,
  ...projectRpcParams,
  ...fileRpcParams,
  ...editorRpcParams,
  ...codeExplanationRpcParams,
  ...remoteRpcParams,
  ...cloudRpcParams,
  ...devicePanelRpcParams,
  ...previewRpcParams,
  ...workspaceChangeRpcParams,
  "tasks.comments.list": z.object({ taskId: z.string() }),
  "tasks.comments.post": z
    .object({
      taskId: z.string(),
      requestKey: z.string().min(1).max(200),
      body: z.string().max(100000),
      recipients: z.array(CommentRecipient).max(8).default([]),
      replyTo: z.string().optional(),
      source: z.enum(["comment", "description"]).default("comment"),
    })
    .strict(),
  "tasks.comments.retry": z.object({ taskId: z.string(), attemptId: z.string() }),
  "tasks.comments.cancel": z.object({ taskId: z.string(), attemptId: z.string() }),
  "tasks.comments.execute": z.object({ taskId: z.string(), attemptId: z.string() }),
  "system.info": z.object({ refresh: z.boolean().optional(), claudeAccountId: ClaudeAccountId.optional() }),
  /** Whether gh is installed, without system.info's paths and harness checks. */
  "system.gh": z.object({}).strict(),
  "agents.updates.get": z.object({}),
  "agents.updates.check": z.object({}),
  "agents.updates.install": z.object({ ids: z.array(HarnessId).min(1).max(3) }).strict(),
  "agents.updates.configure": z.object({ automatic: z.boolean().optional(), dismissed: z.string().max(300).optional() }).strict(),
  "providers.usage": z.object({ provider: z.enum([...HarnessId.options, "anthropic-api"]), claudeAccountId: ClaudeAccountId.optional() }),
  /** The Mac's plan limits for a phone: Codex, then each enabled Claude account. Takes nothing, so a phone cannot force a fresh read. */
  "providers.limits": z.object({}).strict(),
  "providers.codex.reset": z.object({ attemptId: z.string().uuid(), creditId: z.string().min(1).optional(), confirmationToken: z.string().min(1) }),
  /** Active threads by default; every project when none is named. Offset pages older threads in. */
  "threads.list": ThreadListParams,
  "threads.get": z.object({ id: z.string() }),
  "threads.messages": z.object({ id: z.string() }),
  /** The newest thing the person or an agent said in the conversation, its text clipped for a preview. */
  "threads.lastMessage": z.object({ id: z.string() }),
  /** The brain's answer to its Mac's copy of a thread: its code now, minus the commits the Mac names. */
  "threads.snapshot": z.object({ threadId: z.string().min(1).max(200), known: z.array(z.string().regex(/^[0-9a-f]{40,64}$/)).max(32) }).strict(),
  "threads.plans": z.object({ id: z.string() }),
  "threads.implementPlan": z.object({ id: z.string(), planId: z.string(), permissionMode: PermissionPreset }),
  "threads.exportPlan": z.object({
    id: z.string(),
    planId: z.string(),
    filename: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/)
      .max(120),
  }),
  "threads.start": ThreadStartParams,
  "threads.update": z.object({
    id: z.string(),
    /** Through a surviving task of a deleted conversation, only mode, permissions and the draft can change. */
    patch: z.object({
      executionTarget: z.never().optional(),
      title: z.string().optional(),
      mode: RunMode.optional(),
      permissionMode: PermissionPreset.optional(),
      model: z.string().nullable().optional(),
      effort: z.string().nullable().optional(),
      fastMode: z.boolean().optional(),
      agent: AgentKind.optional(),
      archived: z.boolean().optional(),
      pinned: z.boolean().optional(),
      done: z.boolean().optional(),
      /** Epoch milliseconds as a safe integer (zod's int): SQLite stores larger ones that node:sqlite then cannot read back. */
      snoozedUntil: z.number().int().nonnegative().nullable().optional(),
      /** True marks the thread read; false marks it unread. */
      seen: z.boolean().optional(),
      draft: z.string().nullable().optional(),
      prUrl: z.string().nullable().optional(),
    }),
  }),
  /** The conversation goes on with another Claude account from its next message, which resumes its session there. */
  "threads.switchClaudeAccount": z.object({ id: z.string(), claudeAccountId: ClaudeAccountId }),
  "threads.delete": z.object({ id: z.string(), requestKey: z.string().min(1).max(200).optional() }),
  /** A new thread that continues this one's conversation, through the given run (the latest by default). */
  "threads.fork": z.object({ id: z.string(), upToRunId: z.string().optional(), requestKey: z.string().min(1).max(200).optional() }),
  /** Full-text search over what was said in threads. */
  "threads.search": z.object({ query: z.string().min(1), projectId: z.string().optional(), limit: z.number().int().positive().max(100).optional() }),
  /** Move a thread between the checkout and a worktree of its own, carrying uncommitted changes along. */
  "threads.moveWorkspace": z.object({ id: z.string(), to: WorkspaceMode, requestKey: z.string().min(1).max(200).optional() }),
  /** The files a move would carry, for its confirmation. */
  "threads.movePreview": z.object({ id: z.string(), to: WorkspaceMode }),
  /** Ask the agent to summarise the conversation so far and continue from the summary. */
  "threads.compact": z.object({ id: z.string(), requestKey: z.string().min(1).max(200).optional() }),
  /** Hold a message until the current turn ends, then send it. */
  "threads.queue": z.object({ id: z.string(), text: z.string().min(1), attachments: z.array(z.string()).optional(), requestKey: z.string().min(1).optional() }),
  "threads.unqueue": z.object({ id: z.string(), messageId: z.string().min(1) }),
  "threads.sendQueued": z.object({ id: z.string(), messageId: z.string().min(1) }),
  /** Stop a command the agent left running in the background, such as a dev server. */
  "threads.stopCommand": z.object({ id: z.string(), commandId: z.string().min(1) }),
  "subagents.stop": z.object({ threadId: z.string() }),
  "threads.checkpoints": z.object({ id: z.string() }),
  /** What the turn that saved a checkpoint changed, against the checkpoint before it. */
  "threads.turnChanges": z.object({ id: z.string(), checkpointId: z.string(), includePatch: z.boolean().optional(), paths: z.array(z.string().min(1)).min(1).max(500).optional() }).strict(),
  /** Put the working tree back the way it was after a turn. The conversation stays. */
  "threads.restore": z.object({ id: z.string(), checkpointId: z.string(), requestKey: z.string().min(1).max(200).optional() }),
  /** The files a restore would change, for its confirmation. */
  "threads.restorePreview": z.object({ id: z.string(), checkpointId: z.string() }),
  /** Sessions the CLIs keep for this project that are not threads yet. */
  "threads.importable": z.object({ projectId: z.string() }),
  "threads.import": z.object({ projectId: z.string(), sessions: z.array(z.object({ agent: AgentKind, path: z.string() })).min(1) }),
  /** The other threads of the project, for cross-thread messaging in the UI. */
  "threads.send": z.object({ id: z.string(), text: z.string().min(1), fromThreadId: z.string().optional() }),
  "tasks.list": z.object({ threadId: z.string().optional(), projectId: z.string().optional(), statuses: z.array(TaskStatus).optional() }),
  "tasks.get": z.object({ id: z.string() }),
  "tasks.openThread": z.object({ taskId: z.string() }),
  "tasks.executionThread": z.object({ taskId: z.string() }),
  "tasks.create": z
    .object({
      threadId: z.string().optional(),
      projectId: z.string(),
      title: z.string().min(1),
      spec: z.string().optional(),
      priority: TaskPriority.optional(),
      labels: z.array(z.string()).optional(),
      useWorktree: z.boolean().optional(),
      workspaceMode: WorkspaceMode.optional(),
      baseRef: z.string().optional(),
    })
    .refine((value) => value.workspaceMode === undefined || value.useWorktree === undefined || (value.workspaceMode === "worktree") === value.useWorktree, "workspaceMode and useWorktree must agree"),
  "tasks.update": z.object({
    id: z.string(),
    patch: z.object({
      title: z.string().min(1).optional(),
      spec: z.string().nullable().optional(),
      status: TaskStatus.optional(),
      priority: TaskPriority.optional(),
      labels: z.array(z.string()).optional(),
      workspaceMode: WorkspaceMode.optional(),
    }),
  }),
  "tasks.prepareWorkspace": z.object({ taskId: z.string() }),
  /** Deleting the branch as well needs `acceptLoss` to cover whatever work exists only there. */
  "tasks.delete": z.object({ id: z.string(), deleteBranch: z.boolean().optional(), acceptLoss: BranchLoss.optional() }),
  "workspace.cleanup": z.object({ taskId: z.string(), deleteBranch: z.boolean().optional(), acceptLoss: BranchLoss.optional() }),
  /** What deleting a task's branch would lose, before the user confirms it. */
  "workspace.removalImpact": z.object({ taskId: z.string() }),
  "workspace.usage": z.object({ taskId: z.string() }),
  "tasks.start": z.object({ taskId: z.string(), workspaceMode: WorkspaceMode.optional(), executionTarget: z.never().optional() }),
  "runs.start": z.object({
    executionTarget: z.never().optional(),
    taskId: z.string().optional(),
    workspaceMode: WorkspaceMode.optional(),
    threadId: z.string().optional(),
    agent: AgentKind,
    model: z.string().optional(),
    effort: z.string().optional(),
    fastMode: z.boolean().optional(),
    attachments: z.array(z.string()).optional(),
    mode: RunMode,
    permissionMode: PermissionPreset,
    prompt: z.string().min(1),
    resume: z.boolean().optional(),
    /** A conversation goes on with another Claude account: this turn and the next ones run there, resuming its session. */
    claudeAccountId: ClaudeAccountId.optional(),
  }),
  "runs.send": z.object({ runId: z.string(), text: z.string().min(1), attachments: z.array(z.string()).optional() }),
  "runs.interrupt": z.object({ runId: z.string() }),
  "runs.close": z.object({ runId: z.string() }),
  "runs.listForTask": z.object({ taskId: z.string() }),
  "runs.listForThread": z.object({ threadId: z.string() }),
  "events.listForRun": z.object({ runId: z.string(), afterSeq: z.number().int().optional(), limit: z.number().int().positive().max(5000).optional() }),
  /** A run's events from a turn onward, or its newest `turns`, for replaying what the reader sees. */
  "events.page": z.object({ runId: z.string(), fromTurn: z.number().int().nonnegative().optional(), turns: z.number().int().positive().optional() }),
  "events.toolOutput": z.object({ runId: z.string(), toolCallId: z.string() }),
  "mcpApps.open": z.object({ runId: z.string(), toolCallId: z.string() }),
  "mcpApps.close": z.object({ viewId: z.string().uuid() }),
  "mcpApps.read": z.object({ viewId: z.string().uuid(), uri: z.string().max(4096) }),
  "mcpApps.call": z.object({ viewId: z.string().uuid(), name: z.string().max(512), arguments: z.record(z.string(), z.unknown()) }),
  "approvals.resolve": z.object({
    runId: z.string(),
    approvalId: z.string(),
    decision: ApprovalDecision,
    /** Answers to an agent's questions, keyed by question id. */
    answers: z.record(z.string(), z.array(z.string())).optional(),
  }),
  "review.diff": z.object({ taskId: z.string(), sinceReviewed: z.boolean().optional() }),
  /** Uncommitted changes in the project root, where threads work. */
  "review.projectDiff": z.object({ projectId: z.string() }),
  "review.commitProject": z.object({ projectId: z.string(), message: z.string().min(1) }),
  /** The checkout's recent commits and what Push would publish from its branch, whoever committed there. */
  "git.projectLog": z.object({ projectId: z.string(), limit: z.number().int().positive().max(200).optional() }),
  "git.projectPushState": z.object({ projectId: z.string() }),
  "review.pushProject": z.object({ projectId: z.string() }),
  /** What a thread changed in its workspace: the checkout against HEAD, or its worktree against its base. */
  "review.threadDiff": z.object({ threadId: z.string(), comparison: z.enum(["base", "head"]).optional() }),
  "review.commitThread": z.object({ threadId: z.string(), message: z.string().min(1) }),
  "review.pushThread": z.object({ threadId: z.string() }),
  /** Opens a pull request from the thread's branch into `base`. */
  "review.createThreadPr": z.object({ threadId: z.string(), title: z.string().min(1), body: z.string(), base: BranchName }),
  "git.threadLog": z.object({ threadId: z.string(), limit: z.number().int().positive().max(200).optional() }),
  /** Which branch Push would publish from the thread's workspace and which commits origin lacks. Local refs only; never fetches. */
  "git.threadPushState": z.object({ threadId: z.string() }),
  "review.threadPrTemplate": z.object({ threadId: z.string() }),
  /** The instruction files the thread's agent reads, AGENTS.md first and its personal file last. */
  "instructions.list": z.object({ threadId: z.string() }),
  /** Saves one of them. `version` is the one the edit started from, null for a new file; a file changed since then is refused. */
  "instructions.save": z.object({ threadId: z.string(), path: z.string().min(1), content: z.string().max(2 * 1024 * 1024), version: z.string().nullable() }),
  "app.settings.get": z.object({}),
  "app.settings.set": AppSettings.partial(),
  "schedules.list": z.object({ projectId: z.string().optional() }),
  "schedules.create": z.object({
    claudeAccountId: ClaudeAccountId.optional(),
    executionTarget: ExecutionTarget.nullable().optional(),
    projectId: z.string(),
    title: z.string().min(1),
    prompt: z.string().min(1),
    agent: AgentKind.optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    mode: RunMode,
    permissionMode: PermissionPreset,
    workspaceMode: WorkspaceMode,
    everyMinutes: z.number().int().positive(),
  }),
  "schedules.update": z.object({
    id: z.string(),
    patch: z.object({
      claudeAccountId: ClaudeAccountId.optional(),
      executionTarget: ExecutionTarget.nullable().optional(),
      expectedVersion: z.number().int().positive().optional(),
      title: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      everyMinutes: z.number().int().positive().optional(),
      enabled: z.boolean().optional(),
      model: z.string().nullable().optional(),
      effort: z.string().nullable().optional(),
      agent: AgentKind.optional(),
      mode: RunMode.optional(),
      permissionMode: PermissionPreset.optional(),
      workspaceMode: WorkspaceMode.optional(),
    }),
  }),
  "schedules.delete": z.object({ id: z.string() }),
  /** Run a schedule now instead of waiting for its next tick. */
  "schedules.run": z.object({ id: z.string() }),
  /** Durable manual firing. An unchanged request key replays its original outcome. */
  "schedules.trigger": z.object({ id: z.string(), requestKey: z.string().min(1).max(300) }),
  "review.snapshots": z.object({ taskId: z.string() }),
  "review.markReviewed": z.object({ taskId: z.string() }),
  /** A conversation's comments; with a task too, also that task's comments from before it had a conversation. A task alone lists its saved review comments. */
  "review.comments.list": z.object(reviewCommentScope).refine(hasReviewScope, REVIEW_SCOPE_REQUIRED),
  "review.comments.add": z
    .object({
      ...reviewCommentScope,
      path: z.string(),
      startLine: z.number().int().nullable(),
      startSide: z.enum(["old", "new"]).nullable(),
      line: z.number().int().nullable(),
      side: z.enum(["old", "new"]).nullable(),
      lineText: z.string().nullable(),
      body: z.string().min(1),
    })
    .refine(hasReviewScope, REVIEW_SCOPE_REQUIRED)
    .refine((input) => (input.startLine === null) === (input.startSide === null) && (input.startLine === null || input.line !== null), "A range needs a start line, its side and a last line."),
  "review.comments.remove": z.object({ ...reviewCommentScope, id: z.string() }).refine(hasReviewScope, REVIEW_SCOPE_REQUIRED),
  /** Queues the selected comments as one message in the conversation, delivered with its own agent and settings. Repeating an accepted selection returns its message. */
  "review.comments.send": z.object({ threadId: z.string().min(1), taskId: z.string().min(1).optional(), commentIds: z.array(z.string().min(1)).min(1).max(100) }),
  "review.commit": z.object({ taskId: z.string(), message: z.string().min(1) }),
  /** Preview and apply ordinary task output without committing or moving either workspace. */
  "review.checkoutState": z.object({ taskId: z.string() }),
  /** Lossless patch of the task's workspace against its base, written under the app data directory. */
  "review.exportPatch": z.object({ taskId: z.string() }),
  "review.push": z.object({ taskId: z.string() }),
  "review.createPr": z.object({ taskId: z.string(), title: z.string().min(1), body: z.string(), base: BranchName }),
  "git.log": z.object({ taskId: z.string(), limit: z.number().int().positive().max(200).optional() }),
  "agents.models": z.object({ agent: AgentKind.optional(), claudeAccountId: ClaudeAccountId.optional() }),
  /** Which harnesses can start a thread for the default Claude account: `system.info`'s checks without the Mac's paths. */
  "agents.availability": z.object({}),
  "agents.modelCatalog": z.object({ agent: HarnessId.optional(), claudeAccountId: ClaudeAccountId.optional() }),
  "agents.models.refresh": z.object({ agent: HarnessId.optional(), claudeAccountId: ClaudeAccountId.optional() }),
  /**
   * The selected harness's skills where a conversation works, including personal, plugin, and built-in sources.
   * A project's are found from its root. A Workspace conversation, an Orcling's own included, works in its own
   * folder, given as `workingDirectory`; without one, the Workspace's folder.
   */
  "skills.list": z.object({ claudeAccountId: ClaudeAccountId.optional(), projectId: z.string(), workingDirectory: z.string().min(1).max(4096).optional(), agent: HarnessId }),
  /** Stores an image the user pasted or dropped, returning where it lives. */
  "attachments.save": z.object({ name: z.string(), mime: z.string(), dataBase64: z.string() }),
  /** Stores any other file the user attached. Kept apart from images because only an image is ever served back over the asset protocol. */
  "attachments.saveFile": z.object({ name: z.string().min(1).max(255), dataBase64: z.string() }),
  "inbox.list": z.object({}),
  "memory.list": z.object({
    projectId: z.string(),
    types: z.array(MemoryType).optional(),
    sources: z.array(MemorySource).optional(),
    statuses: z.array(MemoryStatus).optional(),
    limit: z.number().int().positive().max(500).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  "memory.search": z.object({ projectId: z.string(), query: z.string().min(1), limit: z.number().int().positive().max(50).optional() }),
  "memory.forTask": z.object({ taskId: z.string() }),
  "memory.record": z.object({ projectId: z.string(), type: MemoryType, title: z.string().min(1), body: z.string().min(1), topicKey: z.string().optional() }),
  "memory.update": z.object({ id: z.string(), projectId: z.string(), patch: z.object({ title: z.string().min(1).optional(), body: z.string().min(1).optional(), type: MemoryType.optional() }) }),
  "memory.feedback": z.object({ id: z.string(), projectId: z.string(), verdict: z.enum(["helpful", "wrong", "stale"]) }),
  "memory.remove": z.object({ id: z.string(), projectId: z.string() }),
  "memory.promote": z.object({ id: z.string(), file: z.enum(["CLAUDE.md", "AGENTS.md"]) }),
  "memory.settings.get": z.object({}),
  "textGeneration.settings.get": z.object({}),
  "textGeneration.settings.set": z.object({
    provider: z.enum(["auto", ...HarnessId.options, "off"]).optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
  }),
  "memory.settings.set": z.object({
    enabled: z.boolean().optional(),
    provider: z.enum(["auto", ...HarnessId.options, "apikey", "off"]).optional(),
    /** Model for the provider being set (or the current one); null restores the provider default. */
    model: z.string().nullable().optional(),
    apiKey: z.string().optional(),
  }),
  /** Diagnostics: synthetic traffic for the bridge benchmark. */
  "bench.start": z.object({
    runs: z.number().int().positive(),
    eventsPerSecond: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    /** Stream into these runs instead of synthetic ones. */
    runIds: z.array(z.string()).optional(),
  }),
  /** Seeds a thread shaped like a large real one, for the renderer benchmark. */
  "bench.seedThread": z.object({}),
  "bench.stop": z.object({}),
} as const;

export type RpcMethod = keyof typeof rpcParams;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof rpcParams)[M]>;

/**
 * Methods whose params carry a credential, besides every slack.* method: the core never logs their params. core's
 * diagnostics test fails for a method with a credential field left off.
 */
const SECRET_PARAMS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "memory.settings.set",
  "remote.push.setKey",
  "cloud.vercel.connect",
  "cloud.claude.save",
  "cloud.codex.apiKey",
  "cloud.opencode.saveKey",
  "cloud.brain.codex.apiKey",
  "providers.codex.reset",
]);

export const secretParams = (method: string): boolean => method.startsWith("slack.") || SECRET_PARAMS.has(method as RpcMethod);

export interface SystemInfo {
  dataDir: string;
  /**
   * One row per registry harness, in registry order. `path` is the binary the
   * app resolves, so a stale second install is visible instead of mysterious.
   */
  harnesses: HarnessInfo[];
  gh: { installed: boolean; path: string | null };
}

export interface ReviewDiff {
  baseSha: string | null;
  patch: string;
  files: FileChange[];
  /** Set when the diff is measured from the last reviewed snapshot instead of the base. */
  since: { snapshotId: string; createdAt: number } | null;
}

export interface ModelOption {
  id: string;
  label: string;
  agent: AgentKind;
  isDefault: boolean;
  /** Effort levels this model accepts, in ascending order; empty when the agent has no such knob. */
  efforts: string[];
  defaultEffort: string | null;
  /** Who bills this model's tokens. A harness's own account until a multi-provider harness arrives. */
  provider?: { id: string; label: string };
  /** Model and CLI eligibility, plus account access where the harness reports it (Claude). The provider can still fall back during a run. */
  fastMode?: { supported: boolean; reason?: string };
  /** Why this model cannot run right now (an old CLI, for instance); absent when it can. */
  unavailable?: string;
  /** An older generation kept selectable behind the main list; never chosen automatically. */
  legacy?: boolean;
}

export type InboxItem =
  | { kind: "task"; task: Task; runId: string | null; reason: "approval" | "review" | "proposed"; detail: string }
  | { kind: "thread"; thread: Thread; runId: string; reason: "approval"; detail: string };

export interface InboxList {
  items: InboxItem[];
}

export type ExtractionProviderChoice = "auto" | HarnessId | "apikey" | "off";

/** Small background text jobs, configured independently of memory and conversation models. */
export interface TextGenerationSettings {
  provider: "auto" | HarnessId | "off";
  model: string | null;
  resolved: { provider: HarnessId; model: string; label: string } | null;
  reason: string | null;
}

/** OpenOrc memory policy and the optional provider for learning from completed runs. */
export interface MemorySettings {
  enabled: boolean;
  provider: ExtractionProviderChoice;
  /** The user's explicit model for the chosen provider; null means the provider default. */
  model: string | null;
  hasApiKey: boolean;
  /** A safe storage-access error; the key is never included in settings responses. */
  apiKeyError?: string;
  /** What summarizes every run when one provider is chosen, or null with a reason when nothing can. Null for Automatic. */
  resolved: ResolvedExtraction | null;
  /** Automatic only: each signed-in agent that summarizes its own runs, and the model it uses. Other agents' runs are not summarized. */
  automatic: ResolvedExtraction[];
  reason: string | null;
}

export interface ResolvedExtraction {
  provider: HarnessId;
  model: string;
  label: string;
  viaApiKey: boolean;
}

export interface RpcResults
  extends
    PullRequestRpcResults,
    OrclingRpcResults,
    ProjectRpcResults,
    FileRpcResults,
    EditorRpcResults,
    CodeExplanationRpcResults,
    ClaudeAccountRpcResults,
    RemoteRpcResults,
    DevicePanelRpcResults,
    PreviewRpcResults,
    CloudRpcResults {
  "tasks.comments.list": TaskDiscussion;
  "tasks.comments.post": TaskComment;
  "tasks.comments.retry": CommentAttempt;
  "tasks.comments.cancel": null;
  "tasks.comments.execute": null;
  "slack.status": SlackStatus;
  "slack.direct.save": null;
  "slack.direct.connect": null;
  "slack.direct.disconnect": null;
  "slack.host.save": null;
  "slack.host.connect": null;
  "slack.host.disconnect": null;
  "slack.device.add": { id: string; deviceKey: string };
  "slack.device.remove": null;
  "slack.client.save": null;
  "slack.client.connect": null;
  "slack.client.disconnect": null;
  "system.info": SystemInfo;
  "system.gh": { installed: boolean };
  "agents.updates.get": AgentUpdates;
  "agents.updates.check": AgentUpdates;
  "agents.updates.install": AgentUpdates;
  "agents.updates.configure": AgentUpdates;
  "providers.usage": import("./provider-usage.js").ProviderUsage;
  "providers.limits": import("./provider-usage.js").PlanLimits[];
  "providers.codex.reset": import("./provider-usage.js").ResetResult;
  "threads.list": ThreadSummary[];
  "threads.get": ThreadSummary | null;
  "threads.messages": ThreadMessage[];
  "threads.lastMessage": ThreadMessage | null;
  "threads.snapshot": import("./thread-owner.js").MirrorSnapshot;
  "threads.plans": ConversationPlan[];
  "threads.implementPlan": Run;
  "threads.exportPlan": { path: string };
  "threads.start": { thread: Thread; run: Run | null };
  "threads.update": Thread;
  "threads.switchClaudeAccount": Thread;
  "threads.delete": null;
  "threads.fork": Thread;
  "threads.search": ThreadSearchHit[];
  "threads.moveWorkspace": Thread;
  "threads.movePreview": ChangePreview;
  "threads.compact": null;
  "threads.queue": QueuedMessage[];
  "threads.unqueue": QueuedMessage[];
  "threads.sendQueued": QueuedMessage[];
  "threads.stopCommand": null;
  "subagents.stop": null;
  "threads.checkpoints": ThreadCheckpoint[];
  "threads.turnChanges": TurnFileChanges;
  "threads.restore": null;
  "threads.restorePreview": ChangePreview;
  "threads.importable": ImportableSession[];
  "threads.import": Thread[];
  "threads.send": null;
  "review.threadDiff": ReviewDiff;
  "review.threadChanges": WorkspaceChanges;
  "review.threadFileDiff": FileDiff;
  "review.commitThread": { sha: string };
  "review.pushThread": { remote: string; branch: string };
  "review.createThreadPr": { url: string };
  "git.threadLog": Commit[];
  "git.threadPushState": PushState;
  /** The repository's pull request template, read from the thread's workspace; null when it has none. */
  "review.threadPrTemplate": { body: string | null };
  "instructions.list": InstructionFile[];
  "instructions.save": InstructionFile;
  "app.settings.get": AppSettings;
  "app.settings.set": AppSettings;
  "schedules.list": Schedule[];
  "schedules.create": Schedule;
  "schedules.update": Schedule;
  "schedules.delete": null;
  "schedules.run": Thread;
  "schedules.trigger": ScheduleRunResult;
  "tasks.start": Run;
  "runs.listForThread": Run[];
  "tasks.list": Task[];
  "tasks.get": Task | null;
  "tasks.openThread": Thread;
  "tasks.executionThread": ThreadSummary | null;
  "tasks.create": Task;
  "tasks.update": Task;
  "tasks.prepareWorkspace": Task;
  "tasks.delete": null;
  "workspace.cleanup": Task;
  "workspace.removalImpact": RemovalImpact;
  "workspace.usage": { bytes: number };
  "runs.start": Run;
  "runs.send": null;
  "runs.interrupt": null;
  "runs.close": null;
  "runs.listForTask": Run[];
  "events.listForRun": AgentEvent[];
  "events.page": { events: AgentEvent[]; fromTurn: number; live: boolean };
  "events.toolOutput": { output: unknown };
  "mcpApps.open": McpAppOpenResult;
  "mcpApps.close": null;
  "mcpApps.read": unknown;
  "mcpApps.call": unknown;
  "approvals.resolve": null;
  "review.diff": ReviewDiff;
  "review.projectDiff": ReviewDiff;
  "review.commitProject": { sha: string };
  "git.projectLog": Commit[];
  "git.projectPushState": PushState;
  "review.pushProject": { remote: string; branch: string };
  "review.snapshots": Snapshot[];
  "review.markReviewed": Task;
  "review.comments.list": ReviewComment[];
  "review.comments.add": ReviewComment;
  "review.comments.remove": null;
  "review.comments.send": { messageId: string; sent: number };
  "review.commit": { sha: string };
  "review.checkoutState": TaskCheckoutState;
  "review.exportPatch": { path: string; files: number; bytes: number };
  "review.push": { remote: string; branch: string };
  "review.createPr": { url: string };
  "git.log": Commit[];
  "agents.models": ModelOption[];
  "agents.availability": HarnessAvailability[];
  "agents.modelCatalog": import("./model-catalog.js").ModelCatalog;
  "agents.models.refresh": import("./model-catalog.js").ModelCatalog;
  "skills.list": AgentSkill[];
  "attachments.save": { path: string; url: string };
  "attachments.saveFile": { path: string; name: string; bytes: number };
  "inbox.list": InboxList;
  "memory.list": Memory[];
  "memory.search": Memory[];
  "memory.forTask": { memories: Memory[]; summaries: SessionSummary[] };
  "memory.record": Memory;
  "memory.update": Memory;
  "memory.feedback": Memory;
  "memory.remove": null;
  "memory.promote": { file: string };
  "memory.settings.get": MemorySettings;
  "memory.settings.set": MemorySettings;
  "textGeneration.settings.get": TextGenerationSettings;
  "textGeneration.settings.set": TextGenerationSettings;
  "bench.start": null;
  "bench.seedThread": { threadId: string; runIds: string[] };
  "bench.stop": null;
}

/** Envelope on the wire, renderer to core. */
export const RpcRequest = z.object({
  type: z.literal("rpc"),
  id: z.number().int(),
  method: z.string(),
  params: z.unknown(),
  /** A window reading again what it already shows, on a timer or after a change, rather than for a person. */
  refresh: z.literal(true).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

/** Envelopes on the wire, core to renderer. */
export const CorePush = z.discriminatedUnion("type", [
  /** Why the core is not ready yet, when it is doing something slow first. `ready` ends it. */
  z.object({ type: z.literal("startup"), message: z.string() }),
  z.object({ type: z.literal("ready"), pid: z.number(), mcpPort: z.number() }),
  z.object({ type: z.literal("rpc.result"), id: z.number().int(), result: z.unknown() }),
  z.object({ type: z.literal("rpc.error"), id: z.number().int(), message: z.string() }),
  z.object({ type: z.literal("frame"), frame: Frame }),
  /** Cache keys whose data changed. The renderer refetches. */
  z.object({ type: z.literal("invalidate"), keys: z.array(z.string()) }),
  /** Frames of these runs were lost on the way from the cloud brain; the renderer reloads them. */
  z.object({ type: z.literal("gap"), runIds: z.array(z.string()) }),
  DevicePanelPush,
  /** Something worth telling the user about when they are looking elsewhere. */
  z.object({
    type: z.literal("notify"),
    kind: z.enum(["finished", "approval", "question", "error", "task", "schedule"]),
    id: z.string().optional(),
    executionId: z.string().optional(),
    actorId: z.string().optional(),
    runId: z.string().optional(),
    approvalId: z.string().optional(),
    threadId: z.string().nullable(),
    taskId: z.string().nullable(),
    title: z.string(),
    body: z.string(),
  }),
  z.object({ type: z.literal("log"), level: z.enum(["info", "warn", "error"]), message: z.string() }),
  z.object({ type: z.literal("bench.done"), eventsSent: z.number(), framesSent: z.number(), durationMs: z.number() }),
]);
export type CorePush = z.infer<typeof CorePush>;
