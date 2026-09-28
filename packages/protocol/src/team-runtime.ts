import { z } from "zod";
import { ModelExecutionSettings, TeamLimits } from "./orchestration.js";
import { TeamContextSeed } from "./team-context.js";
import { RunMode } from "./domain.js";

const id = z.string().min(1);
const time = z.number().int().nonnegative();
export const TeamActorState = z.enum(["queued", "starting", "running", "waiting", "attention", "completed", "cancelled"]);
export type TeamActorState = z.infer<typeof TeamActorState>;
export const TeamAttemptState = z.enum(["starting", "running", "closed", "attention", "cancelled"]);
export type TeamAttemptState = z.infer<typeof TeamAttemptState>;
export const TeamExecutionState = z.enum(["active", "attention", "stopping", "stopped", "completed"]);
export type TeamExecutionState = z.infer<typeof TeamExecutionState>;

/**
 * Every change of state a team may make, in one place. The coordinator, the journal's only writer, takes each step
 * through these; the journal itself refuses any change to a settled turn and never reopens a finished execution.
 * Staying in a state is always allowed.
 */
export const TEAM_ACTOR_TRANSITIONS: Readonly<Record<TeamActorState, readonly TeamActorState[]>> = {
  queued: ["starting", "attention", "cancelled"],
  // A turn can settle before its start is recorded as running.
  starting: ["running", "queued", "waiting", "completed", "attention", "cancelled"],
  running: ["waiting", "queued", "completed", "attention", "cancelled"],
  waiting: ["queued", "completed", "attention", "cancelled"],
  attention: ["queued", "cancelled"],
  // A finished conversation member is reopened by new chat; a finished lead whose room capture failed needs attention.
  completed: ["queued", "attention"],
  // A stop that could not confirm its writers closed leaves them for inspection.
  cancelled: ["attention"],
};
export const TEAM_ATTEMPT_TRANSITIONS: Readonly<Record<TeamAttemptState, readonly TeamAttemptState[]>> = {
  starting: ["running", "closed", "attention", "cancelled"],
  running: ["closed", "attention", "cancelled"],
  // A turn waiting for inspection can still finish, or be retried or stopped.
  attention: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};
export const TEAM_EXECUTION_TRANSITIONS: Readonly<Record<TeamExecutionState, readonly TeamExecutionState[]>> = {
  active: ["attention", "stopping", "completed"],
  attention: ["active", "stopping", "completed"],
  stopping: ["stopped", "attention"],
  stopped: [],
  completed: [],
};
export function teamTransitionAllowed<S extends string>(transitions: Readonly<Record<S, readonly S[]>>, from: S, to: S): boolean {
  return from === to || transitions[from].includes(to);
}

export const TeamAssignmentInput = z.object({
  title: z.string().min(1),
  spec: z.string(),
  attachments: z.array(z.string()),
  responsibility: z.string(),
  settings: ModelExecutionSettings,
});
export type TeamAssignmentInput = z.infer<typeof TeamAssignmentInput>;

/** The lead has an actor record, but never a synthetic Task. */
export const TeamActorRecord = z.object({
  id,
  memberKey: id,
  taskId: id.nullable(),
  parentId: id.nullable(),
  requestKey: id.nullable(),
  requestHash: id.nullable(),
  dependencies: z.array(id),
  input: TeamAssignmentInput,
  state: TeamActorState,
  retries: z.number().int().nonnegative(),
  /** A roster member present in the conversation from admission, with no task or workspace of its own. */
  participant: z.literal(true).optional(),
  /** A successful lead planning reply retained unfinished executable work. */
  modeHold: z.literal("plan").optional(),
  /** Attention caused by an app restart during this actor's turn, not by its own failure; its retry is not counted. */
  interrupted: z.literal(true).optional(),
  /** The manager's turn that reserved this assignment; absent for the lead, roster members and older journals. */
  dispatchedBy: id.optional(),
  directionVersion: z.number().int().nonnegative(),
  deliveredVersion: z.number().int().nonnegative(),
  disposition: z.object({ kind: z.enum(["wait", "complete"]), version: z.number().int().nonnegative(), result: z.string().nullable(), waitFor: z.array(id) }).nullable(),
  result: z.string().nullable(),
  snapshotId: id.nullable(),
  error: z.string().nullable(),
  /** A pending ambient assessment: new room messages this member was not addressed by, due after a short debounce. */
  ambient: z.object({ requestId: id, since: time, dueAt: time, throughSeq: z.number().int().nonnegative() }).nullable().optional(),
});
export type TeamActorRecord = z.infer<typeof TeamActorRecord>;

/** Native acceptance is separate from acknowledgment by a successful captured turn. */
export const TeamLiveDirection = z
  .object({
    messageId: id,
    directionVersion: z.number().int().positive(),
    createdAt: time,
    state: z.enum(["reserved", "accepted", "unavailable", "uncertain"]),
    settledAt: time.nullable(),
    error: z.string().min(1).nullable(),
  })
  .superRefine((value, context) => {
    if (value.state === "reserved") {
      if (value.settledAt !== null || value.error !== null) context.addIssue({ code: "custom", message: "A reserved live direction has no outcome yet." });
    } else {
      if (value.settledAt === null || value.settledAt < value.createdAt) context.addIssue({ code: "custom", message: "A live direction outcome requires an ordered settlement time." });
      if ((value.state === "accepted") !== (value.error === null)) context.addIssue({ code: "custom", message: "Only accepted live direction has no delivery error." });
    }
  });
export type TeamLiveDirection = z.infer<typeof TeamLiveDirection>;

export const TeamAttemptRecord = z
  .object({
    id,
    actorId: id,
    runId: id.nullable(),
    generation: z.number().int().positive(),
    /** Immutable requested mode at reservation; absent only on older journals. */
    mode: RunMode.optional(),
    /** Omitted on journals recorded before explicit context recovery was available. */
    contextCheckpointId: id.optional(),
    /** Reservation fixes either a fresh canonical seed or an owned provider session. */
    contextSeed: TeamContextSeed.optional(),
    contextSessionId: id.optional(),
    /** Explicit ordinary-session choice; null means fresh, omitted only in legacy journals. */
    resumeSessionId: id.nullable().optional(),
    state: TeamAttemptState,
    settings: ModelExecutionSettings,
    configurationVersion: z.number().int().positive(),
    directionVersion: z.number().int().nonnegative(),
    messageIds: z.array(id),
    /** Appended delivery reservations never rewrite this turn's initial input. */
    liveDirections: z.array(TeamLiveDirection).optional(),
    /** Exact images reserved for this turn; absent only in older journals. */
    attachments: z.array(z.string().min(1).max(4096)).optional(),
    snapshotId: id.nullable(),
    error: z.string().nullable(),
    /** Files this turn changed in the shared team workspace, recorded once when the turn closes with a checkpoint. */
    changedFiles: z.array(z.string().min(1).max(4096)).max(500).optional(),
    /** The room delivery this turn's input carried; settled with the turn. Absent for assignments and older journals. */
    roomDeliveryId: id.optional(),
    /** Which turn of its provider process this was, counting from zero. Absent for a turn that had a process to itself. */
    processTurn: z.number().int().nonnegative().optional(),
    /** Why the turn ran: the member was addressed, the lead answered by default, or the member assessed the room on its own. */
    reason: z.enum(["addressed", "lead", "ambient"]).optional(),
    /** The human request the turn served, for ambient budgets. */
    roomRequestId: id.optional(),
    /** Set when the turn closes: a public contribution, or a silent assessment whose final text stayed private. */
    outcome: z.enum(["public", "silent"]).optional(),
    createdAt: time,
    endedAt: time.nullable(),
  })
  .superRefine((value, context) => {
    const choices = Number(value.contextSeed !== undefined) + Number(value.contextSessionId !== undefined);
    if (choices !== (value.contextCheckpointId === undefined ? 0 : 1))
      context.addIssue({ code: "custom", message: "A context checkpoint attempt requires exactly one reserved seed or session; other attempts must omit both." });
    if (value.contextCheckpointId !== undefined && value.resumeSessionId !== undefined)
      context.addIssue({ code: "custom", message: "A context checkpoint attempt must omit the ordinary session reservation." });
  });
export type TeamAttemptRecord = z.infer<typeof TeamAttemptRecord>;

/** Exact input known to belong to this attempt; unresolved native writes are excluded. */
export function teamAttemptMessageIds(attempt: TeamAttemptRecord): string[] {
  return [...attempt.messageIds, ...(attempt.liveDirections ?? []).filter((item) => item.state === "accepted").map((item) => item.messageId)];
}
export function teamAttemptDirectionVersion(attempt: TeamAttemptRecord): number {
  return Math.max(attempt.directionVersion, ...(attempt.liveDirections ?? []).filter((item) => item.state === "accepted").map((item) => item.directionVersion));
}
export function teamAttemptHasUnconfirmedDirection(attempt: TeamAttemptRecord): boolean {
  return (attempt.liveDirections ?? []).some((item) => item.state === "reserved" || item.state === "uncertain");
}

export const TeamMailboxMessage = z.object({
  id,
  sequence: z.number().int().positive(),
  senderId: id,
  recipientId: id,
  kind: z.enum(["direction", "result", "chat"]),
  body: z.string(),
  dedupeKey: id,
  /** One chat message fans out to one row per addressee; rows share this identity. */
  chatId: id.optional(),
  /** Every addressee of the chat message, for rendering; each row still has one recipient. */
  to: z.array(id).max(50).optional(),
  /** Initial journals contain text-only direction and omit this field. */
  attachments: z.array(z.string().min(1).max(4096)).max(20).optional(),
  /** Absence means normal queued delivery, including legacy journals. */
  delivery: z.literal("immediate").optional(),
  /** When the user asked for a queued message to go live after all. Set once; the recorded delivery stays as sent. */
  sendNowAt: time.optional(),
  state: z.enum(["pending", "claimed", "delivered", "cancelled"]),
  attemptId: id.nullable(),
  createdAt: time,
  deliveredAt: time.nullable(),
  /** Cancellation retains the original direction and its idempotency identity. */
  cancelledAt: time.optional(),
  /** The room message this row hands to its recipient; absent for results and for rows older than the room log. */
  roomEventId: id.optional(),
});
export type TeamMailboxMessage = z.infer<typeof TeamMailboxMessage>;

/** A member's advisory claim on a file in the shared workspace; colleagues see it and are refused the same path while it is held. */
export const TeamFileClaim = z.object({ id, actorId: id, path: z.string().min(1).max(4096), note: z.string().max(2000).nullable(), createdAt: time, releasedAt: time.nullable() });
export type TeamFileClaim = z.infer<typeof TeamFileClaim>;

/** A bounded execution journal; provider transcripts remain in the existing run ledger. */
export const TeamExecutionRecord = z.object({
  id,
  instanceId: id,
  threadId: id,
  projectId: id,
  /** Durable UI admission identity; never part of the provider prompt. */
  admission: z.object({ scope: z.enum(["project", "thread"]), requestKey: id.max(200), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  state: TeamExecutionState,
  generation: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  limits: TeamLimits,
  actors: z.array(TeamActorRecord),
  attempts: z.array(TeamAttemptRecord),
  messages: z.array(TeamMailboxMessage),
  /** Absent in journals recorded before shared-workspace claims existed. */
  claims: z.array(TeamFileClaim).max(1000).optional(),
  error: z.string().nullable(),
  createdAt: time,
  updatedAt: time,
  deadlineAt: time,
});
export type TeamExecutionRecord = z.infer<typeof TeamExecutionRecord>;

export interface TeamRunBinding {
  runId: string;
  executionId: string;
  actorId: string;
  attemptId: string;
  generation: number;
}

export const TeamDispatchInput = z.object({
  memberKey: id,
  requestKey: id.max(200),
  title: z.string().trim().min(1).max(300),
  spec: z.string().min(1).max(100_000),
  dependencies: z.array(id).max(100).default([]),
  attachments: z.array(z.string()).max(20).default([]),
});
export type TeamDispatchInput = z.infer<typeof TeamDispatchInput>;
