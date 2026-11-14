import { z } from "zod";
import { FileChange } from "./domain.js";

const count = z.number().int().nonnegative();
const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), insertions: count, deletions: count }),
  z.object({ kind: z.literal("binary") }),
  z.object({ kind: z.literal("omitted"), reason: z.enum(["large", "special"]), bytes: count.nullable() }),
]);
export const HostedChangedFile = FileChange.extend({ body, withheld: z.boolean() });
const recorded = {
  state: z.literal("recorded"),
  turnId: z.string(),
  baseSha: z.string(),
  treeSha: z.string(),
  recordedAt: z.iso.datetime(),
  totals: z.object({ files: count, insertions: count, deletions: count }),
  files: z.array(HostedChangedFile),
  unlisted: count,
};
const missing = z.object({ state: z.literal("missing"), turnId: z.string(), line: z.string() });
export const HostedThreadChanges = z.discriminatedUnion("state", [
  z.object({ ...recorded, comparison: z.literal("base"), missing: z.string().nullable() }),
  missing,
  z.object({ state: z.literal("none"), line: z.string() }),
]);
export type HostedThreadChanges = z.infer<typeof HostedThreadChanges>;
export const HostedTurnChanges = z.discriminatedUnion("state", [
  z.object({ ...recorded, since: z.string().nullable() }),
  missing,
  z.object({ state: z.literal("working"), turnId: z.string(), line: z.string() }),
]);
export type HostedTurnChanges = z.infer<typeof HostedTurnChanges>;
export const HostedFileDiff = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: FileChange.shape.status,
  body,
  patch: z.string(),
  cut: z.object({ shownLines: count, totalLines: count }).nullable(),
  note: z.string().nullable(),
});
export type HostedFileDiff = z.infer<typeof HostedFileDiff>;
export const HostedActionResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("committed"), sha: z.string() }),
  z.object({ kind: z.literal("nothing_to_commit") }),
  z.object({ kind: z.literal("pushed"), branch: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("up_to_date"), branch: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("nothing_to_push") }),
  z.object({ kind: z.literal("pull_request"), number: z.number().int().positive(), url: z.string(), by: z.enum(["found", "person", "app"]), pushed: z.string().nullable() }),
]);
export const HostedReviewAction = z.object({
  id: z.string(),
  kind: z.enum(["commit", "push", "pull_request"]),
  requestedBy: z.string().nullable(),
  state: z.enum(["waiting", "running", "done", "refused", "failed"]),
  result: HostedActionResult.nullable(),
  refusal: z.string().nullable(),
  failure: z.string().nullable(),
  line: z.string().nullable(),
  createdAt: z.iso.datetime(),
  doneAt: z.iso.datetime().nullable(),
});
export type HostedReviewAction = z.infer<typeof HostedReviewAction>;
export const HostedActionAnswer = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), action: HostedReviewAction }),
  z.object({ accepted: z.literal(false), refusal: z.string() }),
]);
export type HostedActionAnswer = z.infer<typeof HostedActionAnswer>;
export const HostedReviewReply = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), action: HostedReviewAction }),
  z.object({ accepted: z.literal(false), refusal: z.string(), line: z.string() }),
]);
export type HostedReviewReply = z.infer<typeof HostedReviewReply>;
export const HostedReviewState = z.object({
  branch: z.string(),
  baseBranch: z.string(),
  work: z.object({ uncommitted: z.object({ since: z.iso.datetime() }).nullable(), unpushed: z.object({ since: z.iso.datetime() }).nullable(), published: z.boolean() }),
  actions: z.array(HostedReviewAction),
  pullRequest: z.object({ url: z.string(), state: z.enum(["open", "closed", "merged"]) }).nullable(),
});
export type HostedReviewState = z.infer<typeof HostedReviewState>;
export const HostedActionRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), id: z.uuid(), message: z.string().trim().min(1).max(10_000) }),
  z.object({ kind: z.literal("push"), id: z.uuid() }),
  z.object({ kind: z.literal("pull_request"), id: z.uuid(), title: z.string().trim().min(1).max(256), body: z.string().max(60_000) }),
]);
export type HostedActionRequest = z.infer<typeof HostedActionRequest>;

/** Requested by desktop windows only. These facts never enter hellos or the agent event stream. */
export const hostedParityRpcParams = {
  "hosted.review.changes": z.object({ threadId: z.string() }).strict(),
  "hosted.review.turn": z.object({ threadId: z.string(), turnId: z.string() }).strict(),
  "hosted.review.file": z.object({ threadId: z.string(), turnId: z.string().optional(), path: z.string().min(1).max(4096) }).strict(),
  "hosted.review.state": z.object({ threadId: z.string() }).strict(),
  "hosted.review.action": z.object({ threadId: z.string(), action: HostedActionRequest }).strict(),
};
export interface HostedParityRpcResults {
  "hosted.review.changes": HostedThreadChanges;
  "hosted.review.turn": HostedTurnChanges;
  "hosted.review.file": HostedFileDiff;
  "hosted.review.state": HostedReviewState;
  "hosted.review.action": HostedReviewReply;
}
