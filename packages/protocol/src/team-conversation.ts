import type { LeadOverrides, MAX_TEAM_DEPTH, ModelExecutionSettings, TeamInstance, TeamRevision } from "./orchestration.js";
import type { TeamActorRecord, TeamExecutionRecord } from "./team-runtime.js";
import type { TeamPublicationRecord, TeamWorkspaceRecord } from "./team-workspaces.js";
import type { PermissionPreset, RunMode, Thread, TurnFileChanges } from "./domain.js";

export interface TeamExecutionAvailability {
  enabled: boolean;
  reason: string | null;
  maxHierarchyDepth: typeof MAX_TEAM_DEPTH;
}
export interface TeamActionAvailability {
  allowed: boolean;
  reason: string | null;
}
export interface TeamPermissionState {
  /** Requested next-turn mode, separately from immutable modes of live processes. Absent in older cached reports. */
  mode?: { requested: RunMode; effective: RunMode | null; pending: boolean };
  requested: PermissionPreset;
  /** Null means active members have different effective policies. */
  effective: PermissionPreset | null;
  pendingRestart: boolean;
  runs: { runId: string; mode: RunMode; requested: PermissionPreset; effective: PermissionPreset; providerPermissionMode: PermissionPreset; pendingRestart: boolean }[];
}
export interface TeamActorView {
  id: string;
  memberKey: string;
  taskId: string | null;
  parentId: string | null;
  /** Retained work suspended by requested Plan mode. */
  modeHold?: "plan";
  /** Present for a roster member in the chat rather than an isolated assignment. */
  participant?: true;
  /** The manager's turn that delegated this assignment, so it shows with that turn. Absent for roster members. */
  dispatchedBy?: string;
  title: string;
  createdAt: number;
  state: TeamActorRecord["state"];
  settings: ModelExecutionSettings;
  /** Distinct provider processes this actor used; a conversation member's process can serve several turns. */
  runIds: string[];
  runs: {
    id: string;
    startedAt: number;
    /** The turn itself: its attempt, and which turn of its process it was. */
    turnId: string;
    turn: number;
    /** The model and effort this turn actually ran with; absent in older cached projections. */
    settings?: ModelExecutionSettings;
    /** When the turn was settled, which places it in the conversation; null while it runs. Absent in older cached projections. */
    endedAt?: number | null;
    /** Files that turn changed in the shared workspace; absent for isolated assignments and older turns. */
    changedFiles?: string[];
    /** Why the turn ran; absent for assignments and older turns. */
    reason?: "addressed" | "lead" | "ambient";
    /** An ambient assessment that added nothing public: its final text stays private to the transcript. */
    silent?: boolean;
  }[];
  /** Files this member currently holds in the shared workspace. */
  claims?: { path: string; note: string | null; createdAt: number }[];
  activeRunId: string | null;
  error: string | null;
  result: string | null;
  waitReason?: string;
  retry: TeamActionAvailability;
  /** Missing only in older cached projections. */
  freshRetry?: TeamActionAvailability;
  workspace:
    | (Pick<TeamWorkspaceRecord, "path" | "state" | "setupState" | "error"> & {
        outputAvailable: boolean;
        /** Present while setup is blocked: explicit recovery controls and their reasons. */
        recovery?: TeamSetupRecovery;
      })
    | null;
}
export interface TeamSetupRecovery {
  retrySetup: TeamActionAvailability;
  acceptSetup: TeamActionAvailability;
  /** Setup rewrote source files; accepting uses the prepared tree as the assignment's input. */
  sourceChanged: boolean;
  retiredPaths: string[];
}
export interface TeamIntegrationRecovery {
  retry: TeamActionAvailability;
  accept: TeamActionAvailability;
  conflicts: string[];
  retiredScratchPaths: string[];
}
export interface TeamReadReceipt {
  actorId: string;
  name: string;
}
export interface TeamExecutionView {
  id: string;
  state: TeamExecutionRecord["state"];
  generation: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  activity: "working" | "waiting" | "attention" | "idle";
  /** `chatId` names the chat entry that carries the opening message when it was addressed to members. */
  initialPrompt: { text: string; attachments: string[]; createdAt: number; seenBy?: TeamReadReceipt[]; chatId?: string };
  userDirections: {
    id: string;
    text: string;
    createdAt: number;
    attachments?: string[];
    seenBy?: TeamReadReceipt[];
    state?: "pending" | "claimed" | "delivered" | "cancelled";
    cancel?: TeamActionAvailability;
    sendNow?: TeamActionAvailability;
    waitReason?: string;
    live?: { runId: string; state: "reserved" | "accepted" | "uncertain" };
    /** Present when another thread in the project sent this direction; absent for the user's own messages. */
    from?: { threadId: string; title: string | null };
  }[];
  actors: TeamActorView[];
  /** Chat between the user and members, and between members; absent in older projections. */
  chat?: TeamChatEntry[];
  publications: (Pick<TeamPublicationRecord, "id" | "sourceActorId" | "targetActorId" | "state" | "scratchPath" | "error"> & { recovery?: TeamIntegrationRecovery })[];
}
export interface TeamChatEntry {
  seenBy?: TeamReadReceipt[];
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  attachments: string[];
  createdAt: number;
  to: { actorId: string; name: string; state: "pending" | "claimed" | "delivered" | "cancelled"; live?: "reserved" | "accepted" | "uncertain"; waitReason?: string }[];
}
/** Public conversation history: no internal agent prompts or result mailbox payloads. */
export interface TeamConversation {
  instance: TeamInstance;
  revision: TeamRevision;
  executions: TeamExecutionView[];
  /** Missing in older reports; mutations must stay disabled until refreshed. */
  actions?: {
    commit: TeamActionAvailability;
    push: TeamActionAvailability;
    createPr: TeamActionAvailability;
    fork?: TeamActionAvailability;
    forkRecovery?: { requestKey: string; upToRunId: string | null; error: string | null };
    restore?: TeamActionAvailability;
    restoreRecovery?: { requestKey: string; checkpointId: string; error: string | null };
    move?: TeamActionAvailability;
    moveRecovery?: { requestKey: string; to: "current" | "worktree"; error: string | null; cancelRequested: boolean };
    delete?: TeamActionAvailability;
    deleteRecovery?: { requestKey: string; error: string | null };
  };
  policy?: TeamPermissionState;
  origin?: { sourceThreadId: string; sourceTitle: string; sourceExists: boolean; sourceRunId: string | null; createdAt: number };
  workspaceRestores?: { id: string; checkpointId: string; sourceRunId: string | null; createdAt: number }[];
  workspaceMoves?: { id: string; to: "current" | "worktree"; createdAt: number }[];
  steer?: TeamActionAvailability;
  /** Recovery metadata only; internal context seeds are never exposed here. */
  context?: {
    compact: TeamActionAvailability;
    checkpoints: { id: string; actorId: string; executionId: string | null; reason: "compact" | "fresh_retry"; createdAt: number }[];
  };
}
export interface ConfigureTeamLeadInput {
  threadId: string;
  leadOverrides: LeadOverrides;
}
/** A deleted conversation's team, read and controlled through one of its surviving saved tasks. */
export interface TeamRetainedTaskRuntime {
  thread: Thread;
  runtime: TeamConversation;
  deletedAt: number;
}

export interface TeamTurnChanges extends TurnFileChanges {
  attribution: "shared-checkpoint";
  note: string;
}
