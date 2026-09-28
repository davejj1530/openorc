import { PullRequestService } from "../services/pull-requests.js";
import type { Handlers } from "./types.js";

type Dependencies = { pullRequests: PullRequestService };
type PullRequestMethod = Extract<keyof Handlers, `pulls.${string}`>;

export function createPullRequestHandlers({ pullRequests }: Dependencies): Pick<Handlers, PullRequestMethod> {
  return {
    "pulls.list": ({ projectId, filter }) => pullRequests.list(projectId, filter),
    "pulls.get": (key) => pullRequests.get(key),
    "pulls.diff": (key) => pullRequests.diff(key),
    "pulls.review.get": (key) => pullRequests.review(key),
    "pulls.review.comment": (input) => pullRequests.comment(input),
    "pulls.review.editComment": ({ id, body, ...key }) => pullRequests.editComment(key, id, body),
    "pulls.review.removeComment": ({ id, ...key }) => {
      pullRequests.removeComment(key, id);
      return null;
    },
    "pulls.review.summary": ({ commitId, summary, ...key }) => {
      pullRequests.setSummary(key, commitId, summary);
      return null;
    },
    "pulls.review.discard": (key) => {
      pullRequests.discard(key);
      return null;
    },
    "pulls.review.start": ({ reviewer, ...key }) => pullRequests.start(key, reviewer),
    "pulls.review.submit": ({ event, summary, as, ...key }) => pullRequests.submit(key, { event, summary, as }),
  };
}
