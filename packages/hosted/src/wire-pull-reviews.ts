import { z } from "zod";
import type { Route } from "./wire.js";

/**
 * A person's review of a pull request of a project only OpenOrc Cloud has: the draft the server keeps for them, and the
 * cloud thread where a model reviews it. The draft is the app's PullRequestReview, its times as ISO strings.
 */
const side = z.enum(["old", "new"]);
const comment = z.object({
  id: z.string(),
  path: z.string(),
  startLine: z.number().int().positive().nullable(),
  startSide: side.nullable(),
  line: z.number().int().positive(),
  side,
  lineText: z.string().nullable(),
  body: z.string(),
  author: z.object({ agent: z.string(), model: z.string().nullable() }).nullable(),
  createdAt: z.iso.datetime(),
});
export type WirePullReviewComment = z.infer<typeof comment>;
const review = z.object({
  projectId: z.string(),
  number: z.number().int().positive(),
  commitId: z.string(),
  summary: z.string(),
  modelSummary: z.string().nullable(),
  threadId: z.string().nullable(),
  baseCommit: z.string().nullable(),
  comments: z.array(comment),
  updatedAt: z.iso.datetime(),
});
export type WirePullReview = z.infer<typeof review>;

const of = (projectId: string, number: number) => `/hosted/pull-reviews/${encodeURIComponent(projectId)}/${number}`;

export const PULL_REVIEW_ROUTES = {
  /** The acting person's draft, or `review: null` when they have none. */
  read: (projectId: string, number: number): Route<{ review: WirePullReview | null }> => ({ method: "GET", path: of(projectId, number), reply: z.object({ review: review.nullable() }) }),
  /** A model starts reviewing the head the app shows, in the review's cloud thread. */
  start: (): Route<{ threadId: string }> => ({ method: "POST", path: "/hosted/pull-reviews", reply: z.object({ threadId: z.string() }) }),
  comment: (projectId: string, number: number): Route<WirePullReviewComment> => ({ method: "POST", path: `${of(projectId, number)}/comments`, reply: comment }),
  editComment: (projectId: string, number: number, id: string): Route<WirePullReviewComment> => ({
    method: "PATCH",
    path: `${of(projectId, number)}/comments/${encodeURIComponent(id)}`,
    reply: comment,
  }),
  removeComment: (projectId: string, number: number, id: string): Route<null> => ({ method: "DELETE", path: `${of(projectId, number)}/comments/${encodeURIComponent(id)}`, reply: null }),
  summary: (projectId: string, number: number): Route<null> => ({ method: "PUT", path: `${of(projectId, number)}/summary`, reply: null }),
  discard: (projectId: string, number: number): Route<null> => ({ method: "DELETE", path: of(projectId, number), reply: null }),
  /** What the app posted to GitHub, as the draft stood when it sent it: the server keeps what changed meanwhile. */
  posted: (projectId: string, number: number): Route<null> => ({ method: "POST", path: `${of(projectId, number)}/posted`, reply: null }),
};
