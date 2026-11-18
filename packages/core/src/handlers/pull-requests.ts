import { PullRequestService } from "../services/pull-requests.js";
import type { Handlers } from "./types.js";

type Dependencies = { pullRequests: PullRequestService };
type PullRequestMethod = Extract<keyof Handlers, `pulls.${string}`>;

export function createPullRequestHandlers({ pullRequests }: Dependencies): Pick<Handlers, PullRequestMethod> {
  return {
    "pulls.list": ({ projectId, state, ...narrowing }) => pullRequests.list(projectId, state, narrowing),
    "pulls.counts": ({ projectId, ...narrowing }) => pullRequests.counts(projectId, narrowing),
    "pulls.choices": ({ projectId, kind }) => pullRequests.choices(projectId, kind),
    "pulls.branches": ({ projectId, prefer }) => pullRequests.branches(projectId, prefer),
    "pulls.get": (key) => pullRequests.get(key),
    "pulls.diff": (key) => pullRequests.diff(key),
    // A project only OpenOrc Cloud has keeps its draft there; one with a folder here, in this Mac's ledger.
    "pulls.review.get": (key) => pullRequests.drafts(key.projectId)?.get(key) ?? pullRequests.review(key),
    "pulls.review.comment": ({ commitId, ...input }) => {
      const { projectId, number, ...comment } = input;
      return pullRequests.drafts(projectId)?.comment({ projectId, number, commitId }, comment) ?? pullRequests.comment({ commitId, ...input });
    },
    "pulls.review.editComment": ({ id, body, ...key }) => pullRequests.drafts(key.projectId)?.editComment(key, id, body) ?? pullRequests.editComment(key, id, body),
    "pulls.review.removeComment": async ({ id, ...key }) => {
      const cloud = pullRequests.drafts(key.projectId);
      if (cloud) await cloud.removeComment(key, id);
      else pullRequests.removeComment(key, id);
      return null;
    },
    "pulls.review.summary": async ({ commitId, summary, ...key }) => {
      const cloud = pullRequests.drafts(key.projectId);
      if (cloud) await cloud.setSummary(key, commitId, summary);
      else pullRequests.setSummary(key, commitId, summary);
      return null;
    },
    "pulls.review.discard": async (key) => {
      const cloud = pullRequests.drafts(key.projectId);
      if (cloud) await cloud.discard(key);
      else pullRequests.discard(key);
      return null;
    },
    "pulls.review.start": ({ reviewer, orclingId, ...key }) => pullRequests.start(key, reviewer, orclingId),
    "pulls.review.submit": ({ event, summary, as, ...key }) => pullRequests.submit(key, { event, summary, as }),
  };
}
