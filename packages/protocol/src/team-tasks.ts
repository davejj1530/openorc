import { z } from "zod";
import type { ReviewComment } from "./domain.js";
import type { TeamActionAvailability, TeamPermissionState } from "./team-conversation.js";
import type { TeamActorRecord } from "./team-runtime.js";
import type { TeamRevision } from "./orchestration.js";

const id = z.string().min(1);
const time = z.number().int().nonnegative();
const requestKey = id.max(200);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const TeamTaskActorReference = z.object({ executionId: id, actorId: id });
export type TeamTaskActorReference = z.infer<typeof TeamTaskActorReference>;

/** Capture intent survives task document edits and the execution that proposed it. */
export const TeamTaskIntent = z.object({
  taskId: id,
  instanceId: id,
  teamRevisionId: id,
  managerKey: id,
  memberKey: id.nullable(),
  parentTaskId: id.nullable(),
  dependencyTaskIds: z.array(id).max(100),
  origin: TeamTaskActorReference.nullable(),
  capture: z.object({ scope: id.max(300), requestKey, payloadHash: fingerprint }).nullable(),
  createdAt: time,
});
export type TeamTaskIntent = z.infer<typeof TeamTaskIntent>;

export const TeamTaskInputSnapshot = z.object({
  title: z.string().trim().min(1).max(300),
  spec: z.string().max(100_000),
  attachments: z.array(id.max(4096)).max(20),
});
export type TeamTaskInputSnapshot = z.infer<typeof TeamTaskInputSnapshot>;

/**
 * The comment fields an accepted review batch retains. Frozen: stored batches
 * are compared field for field, in this order, when a request is replayed.
 */
export const TeamReviewComment = z.object({
  id: z.string(),
  taskId: z.string(),
  snapshotId: z.string().nullable(),
  path: z.string(),
  line: z.number().int().nullable(),
  side: z.enum(["old", "new"]).nullable(),
  body: z.string(),
  sentInRunId: z.string().nullable(),
  createdAt: z.number(),
});
export type TeamReviewComment = z.infer<typeof TeamReviewComment>;

/** The retained copy of a task-labeled comment; a conversation comment cannot join team review. */
export function teamReviewComment(comment: ReviewComment): TeamReviewComment {
  if (comment.threadId !== null || comment.taskId === null) throw new Error(`Review comment ${comment.id} belongs to a conversation, not to team review.`);
  return TeamReviewComment.parse(comment);
}

/** A deleted or edited source comment cannot change an accepted review batch. */
export const TeamReviewBatch = z.object({
  id,
  instanceId: id,
  taskId: id,
  comments: z.array(TeamReviewComment).min(1).max(100),
  prompt: z.string().min(1).max(200_000),
  createdAt: time,
});
export type TeamReviewBatch = z.infer<typeof TeamReviewBatch>;

/** An admission is an accepted request, not evidence that a provider started. */
export const TeamTaskAdmission = z
  .object({
    id,
    instanceId: id,
    taskId: id,
    requestKey,
    payloadHash: fingerprint,
    kind: z.enum(["start", "review"]),
    input: TeamTaskInputSnapshot,
    reviewBatchId: id.nullable(),
    sourceAdmissionId: id.nullable(),
    source: TeamTaskActorReference.extend({ snapshotId: id.nullable() }).nullable(),
    createdAt: time,
  })
  .superRefine((value, context) => {
    if ((value.kind === "review") !== (value.reviewBatchId !== null)) context.addIssue({ code: "custom", message: "Only review admissions must reference a retained review batch." });
  });
export type TeamTaskAdmission = z.infer<typeof TeamTaskAdmission>;

/** Append-only routing history; actor and mailbox state supply delivery status. */
export const TeamTaskAdmissionRoute = z.object({
  admissionId: id,
  sequence: z.number().int().positive(),
  executionId: id,
  actorId: id,
  messageId: id.nullable(),
  role: z.enum(["manager", "assignee"]),
  createdAt: time,
});
export type TeamTaskAdmissionRoute = z.infer<typeof TeamTaskAdmissionRoute>;

/** The lead can complete real task documents while remaining a thread-owned actor. */
export const TeamTaskCompletionIntent = z.object({
  admissionId: id,
  executionId: id,
  actorId: z.literal("lead"),
  attemptId: id,
  result: z.string().trim().min(1).max(100_000),
  createdAt: time,
});
export type TeamTaskCompletionIntent = z.infer<typeof TeamTaskCompletionIntent>;
export const TeamTaskCompletion = TeamTaskCompletionIntent.extend({ runId: id, snapshotId: id });
export type TeamTaskCompletion = z.infer<typeof TeamTaskCompletion>;

export interface TeamTaskAdmissionView {
  id: string;
  requestKey: string;
  kind: "start" | "review";
  createdAt: number;
  state: "queued" | "received" | "running" | "completed" | "attention" | "stopped";
  executionId: string | null;
  actorId: string | null;
  memberKey: string | null;
  role: "manager" | "assignee" | null;
  result: string | null;
  error: string | null;
  reviewBatch: { id: string; comments: TeamReviewComment[] } | null;
  retry: TeamActionAvailability;
}
export interface TeamTaskView {
  taskId: string;
  threadId: string;
  teamName: string;
  /** Set when the owning conversation was deleted; the task keeps its team through its own Agent view. */
  ownerDeletedAt?: number | null;
  /** For a deleted owner: deleting its saved tasks together removes the team's remaining workspaces, branches and exports. */
  deleteOwner?: TeamActionAvailability & { taskIds: string[]; recovery?: { requestKey: string; error: string | null } };
  members: TeamRevision["members"];
  policy: TeamPermissionState;
  managerKey: string;
  memberKey: string | null;
  dependencyTaskIds: string[];
  start: TeamActionAvailability;
  review: TeamActionAvailability;
  /** Publishing this assignment's files on its own branch, separate from the integrated team branch. Absent in older reports. */
  export?: TeamActionAvailability & { branch: string };
  admissions: TeamTaskAdmissionView[];
  claimedCommentIds: string[];
  assignments: { executionId: string; actorId: string; memberKey: string; state: TeamActorRecord["state"]; runIds: string[]; result: string | null }[];
  /** The team is still working on the task: an assignment not yet ended or a request not yet answered. Status stays with the team until then. */
  working: boolean;
}
export interface TeamTaskActionResult {
  admissionId: string;
  task: TeamTaskView;
}
