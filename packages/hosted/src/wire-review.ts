import { HostedActionAnswer, HostedFileDiff, HostedReviewState, HostedThreadChanges, HostedTurnChanges } from "@openorc/protocol";
import type { z } from "zod";
import type { Route } from "./wire.js";

const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });
const root = (threadId: string) => `/hosted/threads/${encodeURIComponent(threadId)}`;
const changes = (threadId: string, turnId?: string) => `${root(threadId)}${turnId === undefined ? "" : `/turns/${encodeURIComponent(turnId)}`}/changes`;

export const REVIEW_ROUTES = {
  changes: (threadId: string) => route("GET", changes(threadId), HostedThreadChanges),
  turn: (threadId: string, turnId: string) => route("GET", changes(threadId, turnId), HostedTurnChanges),
  file: (threadId: string, path: string, turnId?: string) => route("GET", `${changes(threadId, turnId)}/file?${new URLSearchParams({ path })}`, HostedFileDiff),
  state: (threadId: string) => route("GET", root(threadId), HostedReviewState),
  action: (threadId: string, kind: "commit" | "push" | "pull_request") => route("POST", `${root(threadId)}/${kind === "pull_request" ? "pull-request" : kind}`, HostedActionAnswer),
};
