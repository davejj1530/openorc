import { CommentRecipient, type TaskDiscussion, type TaskComment, type CommentAttempt } from "./task-comments.js";
import type { ConversationPlan } from "./execution-mode.js";
import type { TaskForwardingState } from "./task-forwarding.js";
import type { TaskCheckoutState } from "./task-checkout.js";
import { BranchLoss, type ChangePreview, type RemovalImpact } from "./workspace-changes.js";
import { z } from "zod";
import type { AgentUpdates } from "./agent-updates.js";
import { slackRpcParams, type SlackStatus } from "./slack.js";
import { pullRequestRpcParams, type PullRequestRpcResults } from "./pull-requests.js";
import { HarnessId, type HarnessInfo } from "./harness.js";
import { AgentEvent, AgentKind, ApprovalDecision, Frame } from "./events.js";
import type { McpAppOpenResult } from "./mcp-apps.js";
import { ExecutionTarget, LeadOverrides, TeamDraft, type TeamDetail, type TeamPreflight } from "./orchestration.js";
import type { TeamTurnChanges, TeamConversation, TeamExecutionAvailability, TeamRetainedTaskRuntime } from "./team-conversation.js";
import type { TeamTaskActionResult, TeamTaskView } from "./team-tasks.js";
import {
  AgentSkill,
  AppSettings,
  Commit,
  FileChange,
  ImportableSession,
  Memory,
  MemorySource,
  MemoryStatus,
  MemoryType,
  PermissionPreset,
  Project,
  type ProjectGit,
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
  TeamMemberAvatarChoice,
  Thread,
  ThreadCheckpoint,
  ThreadFilter,
  ThreadSearchHit,
  ThreadSummary,
  ThreadMessage,
  type TurnFileChanges,
  type TeamMemberAvatar,
  WorkspaceMode,
} from "./domain.js";

/**
 * Renderer to core RPC. Params are validated in the core; results are typed
 * but trusted. One method map keeps both sides honest.
 */
/** Optional saved-task scope: a deleted conversation's team accepts controls only through a surviving task. */
const TaskScope = z.string().min(1).optional();

const reviewCommentScope = { threadId: z.string().min(1).optional(), taskId: z.string().min(1).optional() };
const hasReviewScope = (scope: { threadId?: string; taskId?: string }) => Boolean(scope.threadId || scope.taskId);
const REVIEW_SCOPE_REQUIRED = "Review comments need a conversation or a task.";

export const rpcParams = {
  ...slackRpcParams,
  ...pullRequestRpcParams,
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
  "system.info": z.object({ refresh: z.boolean().optional() }),
  "agents.updates.get": z.object({}),
  "agents.updates.check": z.object({}),
  "agents.updates.install": z.object({ ids: z.array(HarnessId).min(1).max(3) }).strict(),
  "agents.updates.configure": z.object({ automatic: z.boolean().optional(), dismissed: z.string().max(300).optional() }).strict(),
  "providers.usage": z.object({ provider: z.enum([...HarnessId.options, "anthropic-api"]) }),
  "providers.codex.reset": z.object({ attemptId: z.string().uuid(), creditId: z.string().min(1).optional(), confirmationToken: z.string().min(1) }),
  "workspace.get": z.object({}),
  "workspace.configure": z.object({ entrypoint: z.string().min(1).max(4096) }).strict(),
  "projects.list": z.object({}),
  "projects.get": z.object({ id: z.string() }),
  "projects.git": z.object({ id: z.string() }),
  "projects.import": z.object({ rootPath: z.string() }),
  "projects.remove": z.object({ id: z.string().min(1) }).strict(),
  "projects.updateSettings": z.object({
    id: z.string(),
    settings: z.object({ setupScript: z.string().nullable().optional(), worktreeInclude: z.array(z.string()).optional(), branchPrefix: z.string().optional() }),
  }),
  "orchestration.list": z.object({ projectId: z.string().min(1), includeArchived: z.boolean().optional() }),
  "orchestration.get": z.object({ id: z.string().min(1) }),
  "orchestration.save": z.object({ projectId: z.string().min(1), teamId: z.string().min(1).optional(), expectedRevisionId: z.string().min(1).nullable(), draft: TeamDraft }).strict(),
  "orchestration.archive": z.object({ projectId: z.string().min(1), teamId: z.string().min(1), expectedRevisionId: z.string().min(1), archived: z.boolean() }).strict(),
  "orchestration.avatars.list": z.object({ teamId: z.string().min(1) }).strict(),
  "orchestration.avatars.set": z.object({ teamId: z.string().min(1), memberKey: z.string().min(1), avatar: TeamMemberAvatarChoice }).strict(),
  "orchestration.avatars.reset": z.object({ teamId: z.string().min(1), memberKey: z.string().min(1) }).strict(),
  "orchestration.preflight": z.object({ projectId: z.string().min(1), draft: TeamDraft }).strict(),
  "orchestration.availability": z.object({}).strict(),
  "orchestration.turnChanges": z
    .object({
      threadId: z.string().min(1),
      executionId: z.string().min(1),
      turnId: z.string().min(1),
      includePatch: z.boolean().optional(),
      paths: z.array(z.string().min(1)).min(1).max(500).optional(),
      taskId: TaskScope,
    })
    .strict(),
  "orchestration.runtime": z.object({ threadId: z.string().min(1) }).strict(),
  "orchestration.taskState": z.object({ taskId: z.string().min(1) }).strict(),
  "orchestration.tasks.start": z.object({ taskId: z.string().min(1), requestKey: z.string().min(1).max(200) }).strict(),
  "orchestration.tasks.retry": z.object({ taskId: z.string().min(1), admissionId: z.string().min(1), requestKey: z.string().min(1).max(200) }).strict(),
  "orchestration.review.send": z
    .object({ taskId: z.string().min(1), commentIds: z.array(z.string().min(1)).min(1).max(100), requestKey: z.string().min(1).max(200) })
    .strict()
    .refine((input) => new Set(input.commentIds).size === input.commentIds.length, "Review selection must contain distinct comments."),
  /** A deleted conversation's saved task reads and controls its retained team through its own identity. */
  "orchestration.taskRuntime": z.object({ taskId: z.string().min(1) }).strict(),
  "orchestration.stop": z.object({ threadId: z.string().min(1), executionId: z.string().min(1), taskId: TaskScope }).strict(),
  "orchestration.retry": z
    .object({
      threadId: z.string().min(1),
      executionId: z.string().min(1),
      actorId: z.string().min(1),
      fresh: z.boolean().optional(),
      requestKey: z.string().min(1).max(200).optional(),
      taskId: TaskScope,
    })
    .strict()
    .superRefine((input, ctx) => {
      if (input.fresh && !input.requestKey) ctx.addIssue({ code: "custom", path: ["requestKey"], message: "A fresh-session retry requires a durable request key." });
      if (!input.fresh && input.requestKey) ctx.addIssue({ code: "custom", path: ["requestKey"], message: "Retry request keys apply to a fresh-session retry." });
    }),
  "orchestration.compact": z.object({ threadId: z.string().min(1), requestKey: z.string().min(1).max(200), taskId: TaskScope }).strict(),
  "orchestration.cancelDirection": z.object({ threadId: z.string().min(1), executionId: z.string().min(1), messageId: z.string().min(1), taskId: TaskScope }).strict(),
  "orchestration.sendNow": z.object({ threadId: z.string().min(1), executionId: z.string().min(1), messageId: z.string().min(1), taskId: TaskScope }).strict(),
  "orchestration.implementPlan": z.object({ threadId: z.string().min(1), planId: z.string().min(1) }).strict(),
  "orchestration.send": z
    .object({
      threadId: z.string().min(1),
      text: z.string().trim().min(1).max(100_000),
      attachments: z.array(z.string().min(1).max(4096)).max(20).optional(),
      requestKey: z.string().min(1).max(200),
      now: z.boolean().optional(),
      taskId: TaskScope,
      /** Member keys, "lead" or "all". Absent means the lead, as queued direction. */
      to: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    })
    .strict(),
  "orchestration.configureLead": z.object({ threadId: z.string().min(1), leadOverrides: LeadOverrides, taskId: TaskScope }).strict(),
  /** Explicit setup recovery for a blocked assignment workspace; the request key makes a lost reply replayable. */
  "orchestration.workspace.retrySetup": z
    .object({ threadId: z.string().min(1), executionId: z.string().min(1), actorId: z.string().min(1), requestKey: z.string().min(1).max(200), taskId: TaskScope })
    .strict(),
  "orchestration.workspace.acceptSetup": z
    .object({ threadId: z.string().min(1), executionId: z.string().min(1), actorId: z.string().min(1), requestKey: z.string().min(1).max(200), taskId: TaskScope })
    .strict(),
  /** Explicit integration recovery for a conflicting or interrupted publication. */
  "orchestration.integration.retry": z
    .object({ threadId: z.string().min(1), executionId: z.string().min(1), publicationId: z.string().min(1), requestKey: z.string().min(1).max(200), taskId: TaskScope })
    .strict(),
  "orchestration.integration.accept": z
    .object({ threadId: z.string().min(1), executionId: z.string().min(1), publicationId: z.string().min(1), requestKey: z.string().min(1).max(200), taskId: TaskScope })
    .strict(),
  /** Active threads by default; every project when none is named. Offset pages older threads in. */
  "threads.list": z.object({
    projectId: z.string().optional(),
    projectsOnly: z.boolean().optional(),
    filter: ThreadFilter.optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  "threads.get": z.object({ id: z.string() }),
  "threads.messages": z.object({ id: z.string() }),
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
  /** Creates the thread and starts its first turn in one step. */
  "threads.start": z
    .object({
      projectId: z.string(),
      workingDirectory: z.string().min(1).max(4096).optional(),
      /** Team-only idempotency key for retrying an uncertain launch response. */
      requestKey: z.string().min(1).max(200).optional(),
      agent: AgentKind.optional(),
      executionTarget: ExecutionTarget.optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      fastMode: z.boolean().optional(),
      mode: RunMode,
      permissionMode: PermissionPreset,
      workspaceMode: WorkspaceMode.optional(),
      baseRef: z.string().optional(),
      prompt: z.string().min(1),
      attachments: z.array(z.string()).optional(),
      title: z.string().optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
      if (input.requestKey !== undefined && input.executionTarget?.kind !== "team") ctx.addIssue({ code: "custom", message: "Launch request keys apply only to saved teams.", path: ["requestKey"] });
      if (!input.executionTarget && !input.agent) ctx.addIssue({ code: "custom", message: "Choose a model or a team.", path: ["executionTarget"] });
      if (input.executionTarget && [input.agent, input.model, input.effort, input.fastMode].some((value) => value !== undefined)) {
        ctx.addIssue({ code: "custom", message: "Supply an execution target or legacy model settings, not both.", path: ["executionTarget"] });
      }
    }),
  "threads.update": z.object({
    id: z.string(),
    /** Through a surviving task of a deleted conversation, only mode, permissions and the draft can change. */
    taskId: TaskScope,
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
      snoozedUntil: z.number().nullable().optional(),
      /** True marks the thread read; false marks it unread. */
      seen: z.boolean().optional(),
      draft: z.string().nullable().optional(),
      prUrl: z.string().nullable().optional(),
    }),
  }),
  /** A team conversation needs a request key so an interrupted delete can be retried without repeating cleanup. */
  "threads.delete": z.object({ id: z.string(), requestKey: z.string().min(1).max(200).optional() }),
  /** A new thread that continues this one's conversation, through the given run (the latest by default). */
  "threads.fork": z.object({ id: z.string(), upToRunId: z.string().optional(), requestKey: z.string().min(1).max(200).optional() }),
  /** Full-text search over what was said in threads. */
  "threads.search": z.object({ query: z.string().min(1), projectId: z.string().optional(), limit: z.number().int().positive().max(100).optional() }),
  /** Move a thread between the checkout and a worktree of its own, carrying uncommitted changes along. */
  "threads.moveWorkspace": z.object({ id: z.string(), to: WorkspaceMode, requestKey: z.string().min(1).max(200).optional() }),
  /** The files a move would carry, for its confirmation. */
  "threads.movePreview": z.object({ id: z.string(), to: WorkspaceMode }),
  "threads.cancelMove": z.object({ id: z.string(), requestKey: z.string().min(1).max(200) }),
  "threads.cancelTeamOperation": z.object({ id: z.string().min(1), kind: z.enum(["fork", "restore", "delete"]), requestKey: z.string().min(1).max(200), keepFiles: z.boolean().optional() }).strict(),
  /** Ask the agent to summarise the conversation so far and continue from the summary. */
  "threads.compact": z.object({ id: z.string(), requestKey: z.string().min(1).max(200).optional() }),
  /** Hold a message until the current turn ends, then send it. */
  "threads.queue": z.object({ id: z.string(), text: z.string().min(1), attachments: z.array(z.string()).optional(), requestKey: z.string().min(1).optional() }),
  "threads.unqueue": z.object({ id: z.string(), messageId: z.string().min(1) }),
  "threads.sendQueued": z.object({ id: z.string(), messageId: z.string().min(1) }),
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
  "tasks.forwarding": z.object({ taskId: z.string() }),
  "tasks.forward": z.object({ taskId: z.string(), workspaceMode: WorkspaceMode }),
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
  /** What a thread changed in its workspace: the checkout against HEAD, or its worktree against its base. */
  "review.threadDiff": z.object({ threadId: z.string(), comparison: z.enum(["base", "head"]).optional() }),
  "review.commitThread": z.object({ threadId: z.string(), message: z.string().min(1) }),
  "review.pushThread": z.object({ threadId: z.string() }),
  "review.createThreadPr": z.object({ threadId: z.string(), title: z.string().min(1), body: z.string() }),
  "git.threadLog": z.object({ threadId: z.string(), limit: z.number().int().positive().max(200).optional() }),
  /** Which branch Push would publish from the thread's workspace and which commits origin lacks. Local refs only; never fetches. */
  "git.threadPushState": z.object({ threadId: z.string() }),
  "review.threadPrTemplate": z.object({ threadId: z.string() }),
  /** Tracked files whose path matches, for @ mentions in the composer. */
  "files.search": z.object({ projectId: z.string(), query: z.string(), limit: z.number().int().positive().max(50).optional() }),
  /** Read a cited text file in the conversation's workspace. */
  "files.read": z.object({ scope: z.object({ kind: z.enum(["thread", "task"]), id: z.string() }), path: z.string().min(1) }),
  "app.settings.get": z.object({}),
  "app.settings.set": AppSettings.partial(),
  "schedules.list": z.object({ projectId: z.string().optional() }),
  "schedules.create": z.object({
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
  /** A conversation's comments; with a task too, also that task's comments from before it had a conversation. A task alone lists team review comments. */
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
  "review.createPr": z.object({ taskId: z.string(), title: z.string().min(1), body: z.string() }),
  "git.log": z.object({ taskId: z.string(), limit: z.number().int().positive().max(200).optional() }),
  "agents.models": z.object({ agent: AgentKind.optional() }),
  "agents.modelCatalog": z.object({ agent: HarnessId.optional() }),
  "agents.models.refresh": z.object({ agent: HarnessId.optional() }),
  /** The selected harness's skills in this project, including personal, plugin, and built-in sources. */
  "skills.list": z.object({ projectId: z.string(), agent: HarnessId }),
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

export interface RpcResults extends PullRequestRpcResults {
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
  "agents.updates.get": AgentUpdates;
  "agents.updates.check": AgentUpdates;
  "agents.updates.install": AgentUpdates;
  "agents.updates.configure": AgentUpdates;
  "providers.usage": import("./provider-usage.js").ProviderUsage;
  "providers.codex.reset": import("./provider-usage.js").ResetResult;
  "workspace.get": Project;
  "workspace.configure": Project;
  "projects.list": Project[];
  "projects.get": Project | null;
  "projects.git": ProjectGit;
  "projects.import": Project;
  "projects.remove": { ok: true };
  "projects.updateSettings": Project;
  "orchestration.list": TeamDetail[];
  "orchestration.get": TeamDetail | null;
  "orchestration.save": TeamDetail;
  "orchestration.archive": TeamDetail;
  "orchestration.avatars.list": TeamMemberAvatar[];
  "orchestration.avatars.set": TeamMemberAvatar;
  "orchestration.avatars.reset": TeamMemberAvatar;
  "orchestration.preflight": TeamPreflight;
  "orchestration.availability": TeamExecutionAvailability;
  "orchestration.turnChanges": TeamTurnChanges;
  "orchestration.runtime": TeamConversation | null;
  "orchestration.taskState": TeamTaskView | null;
  "orchestration.taskRuntime": TeamRetainedTaskRuntime | null;
  "orchestration.tasks.start": TeamTaskActionResult;
  "orchestration.tasks.retry": TeamTaskActionResult;
  "orchestration.review.send": TeamTaskActionResult;
  "orchestration.stop": TeamConversation;
  "orchestration.retry": TeamConversation;
  "orchestration.compact": TeamConversation;
  "orchestration.cancelDirection": TeamConversation;
  "orchestration.sendNow": TeamConversation;
  "orchestration.implementPlan": TeamConversation;
  "orchestration.send": TeamConversation;
  "orchestration.configureLead": TeamConversation;
  "orchestration.workspace.retrySetup": TeamConversation;
  "orchestration.workspace.acceptSetup": TeamConversation;
  "orchestration.integration.retry": TeamConversation;
  "orchestration.integration.accept": TeamConversation;
  "threads.list": ThreadSummary[];
  "threads.get": ThreadSummary | null;
  "threads.messages": ThreadMessage[];
  "threads.plans": ConversationPlan[];
  "threads.implementPlan": Run;
  "threads.exportPlan": { path: string };
  "threads.start": { thread: Thread; run: Run | null };
  "threads.update": Thread;
  "threads.delete": null | { rejected: string };
  "threads.fork": Thread | { rejected: string };
  "threads.search": ThreadSearchHit[];
  "threads.moveWorkspace": Thread | { rejected: string };
  "threads.movePreview": ChangePreview;
  "threads.cancelMove": { state: "cancelled" | "applied" };
  "threads.cancelTeamOperation": { state: "cancelled" | "applied" };
  "threads.compact": null;
  "threads.queue": QueuedMessage[];
  "threads.unqueue": QueuedMessage[];
  "threads.sendQueued": QueuedMessage[];
  "threads.checkpoints": ThreadCheckpoint[];
  "threads.turnChanges": TurnFileChanges;
  "threads.restore": null | { rejected: string };
  "threads.restorePreview": ChangePreview;
  "threads.importable": ImportableSession[];
  "threads.import": Thread[];
  "threads.send": null;
  "review.threadDiff": ReviewDiff;
  "review.commitThread": { sha: string };
  "review.pushThread": { remote: string; branch: string };
  "review.createThreadPr": { url: string };
  "git.threadLog": Commit[];
  "git.threadPushState": PushState;
  /** The repository's pull request template, read from the thread's workspace; null when it has none. */
  "review.threadPrTemplate": { body: string | null };
  "files.search": string[];
  "files.read": { path: string; content: string };
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
  "tasks.forwarding": TaskForwardingState;
  "tasks.forward": Task;
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
