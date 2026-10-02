import { z } from "zod";
import { AgentKind, BackgroundCommand, Usage } from "./events.js";
import { ExecutionTarget, TeamRevision } from "./orchestration.js";

/** Domain records as the renderer sees them. Columns are nullable, not optional. */

export const TaskStatus = z.enum(["proposed", "backlog", "in_progress", "review", "done", "archived"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(["none", "low", "medium", "high", "urgent"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const PermissionPreset = z.enum(["review", "trusted", "autonomous"]);
export type PermissionPreset = z.infer<typeof PermissionPreset>;

export const RunMode = z.enum(["plan", "act"]);
export type RunMode = z.infer<typeof RunMode>;

export const ProjectSettings = z.object({
  /** Shell script run in a new worktree before the agent starts. */
  setupScript: z.string().nullable(),
  /** Gitignored files to copy into new worktrees, gitignore syntax. */
  worktreeInclude: z.array(z.string()),
  branchPrefix: z.string(),
  /** Config files from other tools found in the repo, for the user's information. */
  detectedConfigs: z.array(z.string()),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** Stable personal conversation scope; never an imported repository. */
export const WORKSPACE_ID = "openorc-workspace";

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  gitRemote: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  settings: ProjectSettings,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof Project>;

/** What git offers a project's folder right now: nothing, change tracking before the first commit, or everything. */
export const ProjectGit = z.enum(["none", "no_commits", "ready"]);
export type ProjectGit = z.infer<typeof ProjectGit>;

export const WorkspaceMode = z.enum(["worktree", "current"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

export const Task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  spec: z.string().nullable(),
  status: TaskStatus,
  priority: TaskPriority,
  labels: z.array(z.string()),
  /** Isolated worktree, or the project's current checkout. */
  workspaceMode: WorkspaceMode,
  /** Where the task branched from, as the user chose it. */
  baseRef: z.string().nullable(),
  /** The commit the worktree started at; interdiffs and rebases measure from here. */
  baseSha: z.string().nullable(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  /** The conversation that created this task; retained as history. */
  threadId: z.string().nullable(),
  /** The assigned execution conversation. Null until work is assigned. */
  executionThreadId: z.string().nullable().default(null),
  /** Who created it: the user in the UI, or an agent from a thread. */
  origin: z.enum(["user", "agent"]),
  /** Snapshot the user last reviewed; the Files tab can diff from here. */
  reviewedSnapshotId: z.string().nullable(),
  costUsd: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
});
export type Task = z.infer<typeof Task>;

export const RunState = z.enum(["starting", "running", "success", "error", "cancelled"]);
export type RunState = z.infer<typeof RunState>;

/**
 * A conversation with an agent in the project root. Threads are where work
 * starts; tasks record work within them without creating separate conversations.
 */
export const PrState = z.enum(["open", "merged", "closed"]);
export type PrState = z.infer<typeof PrState>;

export const Thread = z.object({
  id: z.string(),
  /** Execution folder for Workspace conversations, independent of their home. */
  workingDirectory: z.string().nullable().optional(),
  projectId: z.string(),
  title: z.string(),
  agent: AgentKind,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  fastMode: z.boolean().default(false),
  mode: RunMode,
  permissionMode: PermissionPreset,
  /** The project's checkout, or a worktree of the thread's own. */
  workspaceMode: WorkspaceMode,
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  /** Where the thread started: its worktree's base commit, or the checkout's HEAD (the empty tree before a first commit). A worktree's Changes tab diffs against it. */
  baseSha: z.string().nullable(),
  /** The branch the thread's worktree started from, which its pull request targets by default. Null when unknown, as in the checkout. */
  baseBranch: z.string().nullable(),
  pinnedAt: z.number().nullable(),
  /** When the user last looked; activity after it is unread. */
  seenAt: z.number().nullable(),
  /** Legacy completion timestamp, retained for persisted data compatibility. */
  doneAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
  /** The conversation's pull request: the one it opened, or the one it reviews. Its state follows GitHub. */
  prUrl: z.string().nullable(),
  prState: PrState.nullable(),
  forkedFromId: z.string().nullable(),
  /** The parent's runs up to and including this one are part of the fork's conversation. */
  forkedAtRunId: z.string().nullable(),
  /** What the user had typed in the composer when they left. */
  draft: z.string().nullable(),
  /** The CLI transcript this thread was imported from, if any. */
  importedFrom: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastActivityAt: z.number(),
  archivedAt: z.number().nullable(),
});
export type Thread = z.infer<typeof Thread>;

export const ThreadActivity = z.enum(["idle", "running", "waiting"]);
export type ThreadActivity = z.infer<typeof ThreadActivity>;

/**
 * The provider process behind the thread. Live while a process is attached;
 * idle when the next message resumes the stored session; lost when the
 * provider no longer has that session; error when the last run failed.
 */
export const ThreadSession = z.object({
  status: z.enum(["live", "idle", "lost", "error"]),
  message: z.string().nullable(),
});
export type ThreadSession = z.infer<typeof ThreadSession>;

export const QueuedMessage = z.object({
  id: z.string(),
  text: z.string(),
  attachments: z.array(z.string()),
  queuedAt: z.number(),
  error: z.string().nullable().optional(),
  interrupted: z.boolean().optional(),
});
export type QueuedMessage = z.infer<typeof QueuedMessage>;

/** A thread with what is happening on it right now, for lists and the sidebar. */
/**
 * A conversation whose copy is on no branch, such as a pull request's copy under review. Outside a team, which
 * publishes through a branch of its own, nothing in it is committed, pushed or opened as a pull request.
 */
export function isDetachedCopy(thread: Pick<Thread, "worktreePath" | "branch">): boolean {
  return thread.worktreePath !== null && thread.branch === null;
}

export const ThreadSummary = Thread.extend({
  /** Whether any execution has started; absent in older cached summaries. */
  hasStarted: z.boolean().optional(),
  /** Saved team ownership; absent in older cached summaries. */
  teamInstanceId: z.string().nullable().optional(),
  /** One provider per saved team member, or the solo thread provider; absent in older summaries. */
  agents: z.array(AgentKind).optional(),
  activity: ThreadActivity,
  /** Commands the agent left running after its turn, such as a dev server; absent in older cached summaries. */
  backgroundCommands: z.array(BackgroundCommand).optional(),
  unread: z.boolean(),
  session: ThreadSession,
  /** Context use on the latest turn, when the agent reported it. */
  context: z.object({ used: z.number().int(), window: z.number().int().nullable() }).nullable(),
  queued: z.array(QueuedMessage),
  /**
   * When the agent on this thread's active run last produced an event, epoch ms.
   * Null when no run is live, because a thread that is not running cannot stall.
   *
   * Deliberately not `lastActivityAt`, which is a different measurement: that
   * column moves only at run start, user send and turn end, so it stands still
   * for the whole of a turn however long the agent works. This moves on every
   * event the provider emits, so `Date.now() - lastAgentEventAt` is the age of
   * the agent's silence, which is what a stall indicator needs.
   *
   * It falls back to the run's start time until the first event arrives, so a
   * provider that hung before saying anything still ages instead of reading as
   * absent. While non-null it never goes backwards.
   */
  lastAgentEventAt: z.number().nullable(),
  taskCount: z.number().int(),
  openTaskCount: z.number().int(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

/** Conversation messages that precede or do not require a provider run. */
export const ThreadMessage = z.object({ id: z.string(), role: z.enum(["user", "assistant", "system"]), text: z.string(), createdAt: z.number(), attachments: z.array(z.string()).optional() });
export type ThreadMessage = z.infer<typeof ThreadMessage>;

export const ThreadFilter = z.enum(["active", "done", "archived", "all"]);
export type ThreadFilter = z.infer<typeof ThreadFilter>;

/** A message that matched a search, with enough around it to recognise. */
export const ThreadSearchHit = z.object({
  threadId: z.string(),
  threadTitle: z.string(),
  projectId: z.string(),
  runId: z.string(),
  role: z.enum(["user", "assistant"]),
  snippet: z.string(),
  ts: z.number(),
  /** Set when the run belonged to a task, such as a team assignment; the hit opens that task's Agent view. */
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  /** The team member whose run said this, when the run was part of a team execution. */
  member: z.object({ key: z.string(), name: z.string() }).nullable(),
});
export type ThreadSearchHit = z.infer<typeof ThreadSearchHit>;

/** The working tree after one turn, so the user can go back to it. */
export const ThreadCheckpoint = z.object({
  id: z.string(),
  threadId: z.string(),
  runId: z.string().nullable(),
  turn: z.number().int(),
  treeSha: z.string(),
  diffStat: z.object({ files: z.number().int(), insertions: z.number().int(), deletions: z.number().int(), untracked: z.number().int() }),
  /** Set for the checkpoints a restore saves around itself, such as "Before restoring turn 3". */
  note: z.string().nullable(),
  /** The folder the files were read from, so a restore never writes them into another location. Null before this was recorded. */
  root: z.string().nullable(),
  createdAt: z.number(),
});
export type ThreadCheckpoint = z.infer<typeof ThreadCheckpoint>;

/** What a finished turn changed, read from its saved checkpoint tree rather than the working directory. */
export interface TurnFileChanges {
  files: { path: string; added: number | null; removed: number | null }[];
  patch: string | null;
}

/** A session found in a CLI's own history for this project, offered for import. */
export const ImportableSession = z.object({
  agent: AgentKind,
  path: z.string(),
  sessionId: z.string(),
  title: z.string(),
  messages: z.number().int(),
  startedAt: z.number(),
  /** Already imported as this thread. */
  threadId: z.string().nullable(),
});
export type ImportableSession = z.infer<typeof ImportableSession>;

export const ScheduleLaunchSnapshot = z.object({
  projectId: z.string(),
  title: z.string(),
  prompt: z.string(),
  agent: AgentKind,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  mode: RunMode,
  permissionMode: PermissionPreset,
  workspaceMode: WorkspaceMode,
  everyMinutes: z.number().int().positive(),
  executionTarget: ExecutionTarget.nullable().default(null),
});
export type ScheduleLaunchSnapshot = z.infer<typeof ScheduleLaunchSnapshot>;

export const ScheduleFiringView = z.object({
  id: z.string(),
  state: z.enum(["pending", "started", "skipped", "failed", "cancelled"]),
  trigger: z.enum(["timer", "manual"]),
  scheduledFor: z.number().nullable(),
  threadId: z.string().nullable(),
  executionId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type ScheduleFiringView = z.infer<typeof ScheduleFiringView>;
export const ScheduleFiringRecord = ScheduleFiringView.extend({
  scheduleId: z.string(),
  requestKey: z.string().min(1).max(300),
  scheduleVersion: z.number().int().positive(),
  snapshot: ScheduleLaunchSnapshot,
});
export type ScheduleFiringRecord = z.infer<typeof ScheduleFiringRecord>;

export const Schedule = ScheduleLaunchSnapshot.extend({
  id: z.string(),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number(),
  lastThreadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Read-only projections; the persisted target always pins the original revision. */
  team: z.object({ revision: TeamRevision, archived: z.boolean() }).nullable().optional(),
  lastFire: ScheduleFiringView.nullable().optional(),
});
export type Schedule = z.infer<typeof Schedule>;

export type ScheduleRunResult = { status: "started"; firingId: string; thread: Thread } | { status: "skipped" | "cancelled" | "failed"; firingId: string; reason: string; threadId?: string };

/** App-wide preferences that are not about memory. */
export const AppSettings = z.object({
  /** Persisted legacy key; team execution is now Beta and enabled for new profiles. */
  experimentalTeamExecution: z.boolean().default(true),
  notifications: z.boolean(),
  sound: z.boolean(),
  /** Idle days before a thread is marked done on its own; null keeps threads active. */
  autoDoneDays: z.number().int().positive().nullable(),
  autoDoneOnPrMerge: z.boolean(),
  /** Days a done thread sits before it is archived; null keeps done threads. */
  autoArchiveDoneDays: z.number().int().positive().nullable(),
  /** Where new threads work by default. */
  defaultWorkspaceMode: WorkspaceMode,
  /** Most recent user selection; defaults new work without changing live run policies. */
  defaultPermissionMode: PermissionPreset,
  /** Minutes a provider process may sit idle between turns before it is closed; the session resumes on the next message. Null keeps processes running. */
  idleProcessMinutes: z.number().int().positive().nullable().default(10),
  /** Whether Claude Code connects the MCP servers from the user's own Claude configuration in threads. Off, only OpenOrc's tools load and the CLI starts about two seconds sooner. */
  claudeUserMcpServers: z.boolean().default(true),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const Run = z.object({
  id: z.string(),
  /** Canonical execution folder captured when this run was admitted. */
  workingDirectory: z.string().nullable().optional(),
  /** Exactly one of taskId, threadId and commentTurnId is set. */
  commentTurnId: z.string().nullable().optional(),
  taskId: z.string().nullable(),
  threadId: z.string().nullable(),
  agent: AgentKind,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  fastMode: z.boolean().default(false),
  mode: RunMode,
  permissionMode: PermissionPreset,
  externalSessionId: z.string().nullable(),
  state: RunState,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  usage: Usage.nullable(),
  resultText: z.string().nullable(),
  /** Why the run failed, when it did. */
  error: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const DiffStat = z.object({
  files: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  untracked: z.number().int(),
});
export type DiffStat = z.infer<typeof DiffStat>;

export const Snapshot = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().nullable(),
  turn: z.number().int(),
  treeSha: z.string(),
  diffStat: DiffStat,
  createdAt: z.number(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const FileChange = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  oldPath: z.string().nullable(),
});
export type FileChange = z.infer<typeof FileChange>;

/**
 * A note on a diff line or range. It belongs to the conversation whose workspace the
 * diff shows; the task is only a label. Team review comments have no
 * conversation and travel through their task's review requests instead.
 */
export const ReviewComment = z.object({
  id: z.string(),
  threadId: z.string().nullable(),
  taskId: z.string().nullable(),
  snapshotId: z.string().nullable(),
  path: z.string(),
  /** The first line of a multi-line comment, as GitHub's start_line/start_side; null for one line. */
  startLine: z.number().int().nullable(),
  startSide: z.enum(["old", "new"]).nullable(),
  /** The commented line, or the last line of a range. */
  line: z.number().int().nullable(),
  side: z.enum(["old", "new"]).nullable(),
  /** What the commented lines said when the comment was written, one per line, so a later edit shows it as outdated. */
  lineText: z.string().nullable(),
  body: z.string(),
  sentInRunId: z.string().nullable(),
  /** The queued conversation message that accepted this comment: acceptance, not provider delivery. Null again once that message is removed from the queue. */
  sentMessageId: z.string().nullable(),
  createdAt: z.number(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const MemoryType = z.enum(["decision", "spec", "lesson", "preference", "convention", "command", "env_quirk", "ownership"]);
export type MemoryType = z.infer<typeof MemoryType>;

export const MemoryScope = z.enum(["project", "user", "global"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryStatus = z.enum(["active", "superseded", "retracted", "stale"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MemorySource = z.enum(["user", "agent", "tool", "extraction"]);
export type MemorySource = z.infer<typeof MemorySource>;

export const Memory = z.object({
  id: z.string(),
  scope: MemoryScope,
  projectId: z.string().nullable(),
  type: MemoryType,
  topicKey: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  confidence: z.number(),
  status: MemoryStatus,
  source: MemorySource,
  sourceRunId: z.string().nullable(),
  sourceTaskId: z.string().nullable(),
  evidenceCount: z.number().int(),
  files: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastConfirmedAt: z.number(),
});
export type Memory = z.infer<typeof Memory>;

export const SessionSummary = z.object({
  runId: z.string(),
  taskId: z.string().nullable(),
  threadId: z.string().nullable(),
  projectId: z.string(),
  request: z.string(),
  workDone: z.string(),
  outcome: z.string(),
  openItems: z.array(z.string()),
  model: z.string().nullable(),
  createdAt: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const ExtractionJob = z.object({
  runId: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "skipped"]),
  error: z.string().nullable(),
  memoriesWritten: z.number().int(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type ExtractionJob = z.infer<typeof ExtractionJob>;

export const Commit = z.object({
  sha: z.string(),
  author: z.string(),
  at: z.number(),
  subject: z.string(),
});
export type Commit = z.infer<typeof Commit>;

/** What Push would publish from a workspace, judged by what origin was last seen to have. */
export const PushState = z.object({
  /** The branch Push publishes; null when there is none. */
  branch: z.string().nullable(),
  /** Why Push can't run, such as no origin remote; null when it can. */
  blocked: z.string().nullable(),
  /** Whether origin already has the branch. */
  published: z.boolean(),
  /** How many commits origin doesn't have yet. */
  unpushedCount: z.number().int(),
  /** The newest of those commits, enough to mark every row of the longest log. */
  unpushed: z.array(z.string()),
});
export type PushState = z.infer<typeof PushState>;

/** A member's effective saved choice; every current member has an allocation. */
export const TeamMemberAvatarChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default"), index: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("custom"),
      path: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => !value.includes("\0"), "Avatar paths cannot contain null bytes."),
    })
    .strict(),
]);
export type TeamMemberAvatarChoice = z.infer<typeof TeamMemberAvatarChoice>;

export const TeamMemberAvatar = z
  .object({
    teamId: z.string().min(1),
    memberKey: z.string().min(1),
    avatar: TeamMemberAvatarChoice,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TeamMemberAvatar = z.infer<typeof TeamMemberAvatar>;

/** A skill discovered for one harness in one project. Its `name` is the harness's invocation ID. */
export const AgentSkill = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["project", "user", "plugin", "system"]),
  path: z.string(),
});
export type AgentSkill = z.infer<typeof AgentSkill>;

/**
 * An instruction file a thread's agent reads, as it is on disk: one in the thread's folder, or the agent's personal
 * file that every project shares. A missing file has no version and empty content; saving it creates it.
 */
export const InstructionFile = z.object({
  scope: z.enum(["project", "personal"]),
  path: z.string(),
  content: z.string(),
  version: z.string().nullable(),
});
export type InstructionFile = z.infer<typeof InstructionFile>;
