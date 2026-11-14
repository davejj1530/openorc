import type { HostedActionRequest, HostedReviewReply, RpcParams, RpcResults } from "@openorc/protocol";
import type { Threads } from "./threads.js";
import { Refused } from "./session.js";
import { refuse } from "./sends.js";
import { REVIEW_ROUTES } from "./wire-review.js";
import { completePatch, reviewChanges, turnFiles } from "./translate-review.js";

export const changes = (threads: Threads, { threadId }: RpcParams<"hosted.review.changes">) => threads.on(threadId).request(REVIEW_ROUTES.changes(threadId));
export const turn = (threads: Threads, { threadId, turnId }: RpcParams<"hosted.review.turn">) => threads.on(threadId).request(REVIEW_ROUTES.turn(threadId, turnId));
export const file = (threads: Threads, { threadId, path, turnId }: RpcParams<"hosted.review.file">) => threads.on(threadId).request(REVIEW_ROUTES.file(threadId, path, turnId));
export const state = (threads: Threads, { threadId }: RpcParams<"hosted.review.state">) => threads.on(threadId).request(REVIEW_ROUTES.state(threadId));

export async function action(threads: Threads, { threadId, action: request }: RpcParams<"hosted.review.action">): Promise<HostedReviewReply> {
  const { kind, ...body } = request;
  const reply = await threads.on(threadId).request(REVIEW_ROUTES.action(threadId, kind), body);
  if (!reply.accepted) {
    try {
      await refuse(threads.calls, reply.refusal, threads.row(threadId).settings);
    } catch (error) {
      return { ...reply, line: error instanceof Error ? error.message : "This action was refused." };
    }
  }
  if (!reply.accepted) throw new Refused("This action was refused.");
  if (reply.action.id !== request.id || reply.action.kind !== kind) throw new Refused("The server returned a different action. Refresh before trying again.");
  void threads.refresh();
  return reply;
}

export async function legacyChanges(threads: Threads, params: RpcParams<"review.threadChanges">) {
  const result = await changes(threads, params);
  if (params.comparison === "head") throw new Refused("Uncommitted changes aren't available separately in this cloud thread yet.");
  return reviewChanges(result);
}

export async function legacyDiff(threads: Threads, params: RpcParams<"review.threadDiff">): Promise<RpcResults["review.threadDiff"]> {
  const read = await legacyChanges(threads, params);
  if (read.unlisted) throw new Refused("Open Changes to read the full file count.");
  const on = threads.on(params.threadId);
  const files = await Promise.all(read.files.map((file) => on.request(REVIEW_ROUTES.file(params.threadId, file.path))));
  return { baseSha: read.baseSha, files: read.files, patch: completePatch(files), since: null };
}

export async function legacyTurn(threads: Threads, params: RpcParams<"threads.turnChanges">): Promise<RpcResults["threads.turnChanges"]> {
  const read = await turn(threads, { threadId: params.id, turnId: params.checkpointId });
  const files = turnFiles(read).filter((file) => !params.paths || params.paths.includes(file.path));
  const on = threads.on(params.id);
  const diffs = params.includePatch ? await Promise.all(files.map((file) => on.request(REVIEW_ROUTES.file(params.id, file.path, params.checkpointId)))) : null;
  return { files, patch: diffs ? completePatch(diffs) : null };
}

const retries = new WeakMap<Threads, Map<string, HostedActionRequest>>();
/** A legacy caller can retry a lost response, but cannot mistake accepted work for completed work. */
async function legacyAction(threads: Threads, threadId: string, request: HostedActionRequest) {
  let pending = retries.get(threads);
  if (!pending) retries.set(threads, (pending = new Map()));
  const detail = request.kind === "pull_request" ? [request.title, request.body] : null;
  const key = JSON.stringify([threadId, request.kind, request.kind === "commit" ? request.message : detail]);
  const kept = pending.get(key) ?? request;
  pending.set(key, kept);
  const answer = await action(threads, { threadId, action: kept });
  if (!answer.accepted) {
    pending.delete(key);
    throw new Refused(answer.line);
  }
  const result = answer.action;
  if (result.state === "waiting" || result.state === "running") throw new Refused(result.line ?? `The ${request.kind === "pull_request" ? "pull request" : request.kind} is ${result.state}.`);
  pending.delete(key);
  if (result.state !== "done" || !result.result) throw new Refused(result.line ?? "This action could not finish. Open Changes to try again.");
  return result.result;
}

export async function commit(threads: Threads, params: RpcParams<"review.commitThread">) {
  const result = await legacyAction(threads, params.threadId, { kind: "commit", id: crypto.randomUUID(), message: params.message });
  if (result.kind !== "committed") throw new Refused("There is nothing to commit.");
  return { sha: result.sha };
}
export async function push(threads: Threads, params: RpcParams<"review.pushThread">) {
  const result = await legacyAction(threads, params.threadId, { kind: "push", id: crypto.randomUUID() });
  if (result.kind !== "pushed" && result.kind !== "up_to_date") throw new Refused("There is nothing to push.");
  return { remote: "origin", branch: result.branch };
}
export async function pullRequest(threads: Threads, params: RpcParams<"review.createThreadPr">) {
  if (params.base !== threads.row(params.threadId).baseBranch) throw new Refused("This cloud thread opens pull requests into its starting branch.");
  const result = await legacyAction(threads, params.threadId, { kind: "pull_request", id: crypto.randomUUID(), title: params.title, body: params.body });
  if (result.kind !== "pull_request") throw new Refused("The pull request could not be opened.");
  return { url: result.url };
}
