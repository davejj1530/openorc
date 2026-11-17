import { HostedActionAnswer, HostedCommitChanges, HostedFileDiff, HostedReviewState, HostedThreadChanges, HostedThreadCommits, HostedTurnChanges } from "@openorc/protocol";
import type { z } from "zod";
import type { Route } from "./wire.js";

const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });
const root = (threadId: string) => `/hosted/threads/${encodeURIComponent(threadId)}`;
const changes = (threadId: string, turnId?: string) => `${root(threadId)}${turnId === undefined ? "" : `/turns/${encodeURIComponent(turnId)}`}/changes`;
const commitChanges = (threadId: string, sha: string) => `${root(threadId)}/commits/${encodeURIComponent(sha)}/changes`;

export const REVIEW_ROUTES = {
  changes: (threadId: string) => route("GET", changes(threadId), HostedThreadChanges),
  turn: (threadId: string, turnId: string) => route("GET", changes(threadId, turnId), HostedTurnChanges),
  file: (threadId: string, path: string, turnId?: string) => route("GET", `${changes(threadId, turnId)}/file?${new URLSearchParams({ path })}`, HostedFileDiff),
  state: (threadId: string) => route("GET", root(threadId), HostedReviewState),
  commits: (threadId: string) => route("GET", `${root(threadId)}/commits`, HostedThreadCommits),
  /** One commit's changes against its first parent, and one file's patch in them. */
  commit: (threadId: string, sha: string) => route("GET", commitChanges(threadId, sha), HostedCommitChanges),
  commitFile: (threadId: string, sha: string, path: string) => route("GET", `${commitChanges(threadId, sha)}/file?${new URLSearchParams({ path })}`, HostedFileDiff),
  action: (threadId: string, kind: "commit" | "push" | "pull_request") => route("POST", `${root(threadId)}/${kind === "pull_request" ? "pull-request" : kind}`, HostedActionAnswer),
};
