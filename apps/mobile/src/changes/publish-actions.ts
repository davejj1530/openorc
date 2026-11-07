import { invalidatesFor, shortSha } from "@openorc/client";
import type { RemoteMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { hostClient, hostLink } from "../client";
import { openedNotice } from "./publish-state";
import { changeDrafts, publishStore } from "./publishing";

/** A write through the desktop's own method on the thread's host, refreshing what it changed once the host answers. */
async function write<M extends RemoteMethod>(host: string | null, method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const result = await hostLink(host).connection.call(method, params);
  hostClient(host).invalidateTags(invalidatesFor(method, params), { immediate: true });
  return result;
}

/** Commits everything uncommitted. A commit made clears its draft. `headBefore` is the log's head as the reader saw it. */
export async function commitThread(host: string | null, threadId: string, message: string, headBefore: string | null): Promise<boolean> {
  const made = await publishStore.run(
    threadId,
    { action: "commit", message, headBefore },
    () => write(host, "review.commitThread", { threadId, message }),
    (result) => `Committed ${shortSha(result.sha)}`,
  );
  if (made) changeDrafts.setMessage(threadId, "");
  return made !== null;
}

/** Pushes the branch to origin, with no confirm: pushing twice is harmless. */
export function pushThread(host: string | null, threadId: string): Promise<unknown> {
  return publishStore.run(
    threadId,
    { action: "push" },
    () => write(host, "review.pushThread", { threadId }),
    (result) => `Pushed ${result.branch} to ${result.remote}`,
  );
}

/** Opens the pull request through the Mac's gh. One opened clears the fields the reader edited. */
export async function openPullRequest(host: string | null, threadId: string, params: Omit<RpcParams<"review.createThreadPr">, "threadId">): Promise<boolean> {
  const opened = await publishStore.run(
    threadId,
    { action: "pr" },
    () => write(host, "review.createThreadPr", { threadId, ...params }),
    (result) => openedNotice(result.url),
  );
  if (opened) changeDrafts.clearPullRequest(threadId);
  return opened !== null;
}
