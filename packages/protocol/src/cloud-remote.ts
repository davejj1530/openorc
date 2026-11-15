import { z } from "zod";
import type { RoutedMethod } from "./owners.js";
import type { RpcMethod } from "./rpc.js";

/**
 * A Mac that shares it serves a phone the spaces and OpenOrc Cloud threads of the person signed in on that Mac. A
 * session that does not share it is served the Mac alone, as phones always were. It says the Mac has the methods,
 * never that the person may read something: the server answers that on every call.
 */
export const CLOUD_THREADS = "cloud-threads";
export const supportsCloudThreads = (capabilities: readonly string[] = []): boolean => capabilities.includes(CLOUD_THREADS);

/** Who is signed in on the Mac a phone reads OpenOrc Cloud through: their name and picture, and nothing else of the account. */
export interface AccountPerson {
  /** Null until the server first answers with it. */
  name: string | null;
  /** Their picture as a data URL; null for their initials. */
  image: string | null;
}

export const cloudRemoteRpcParams = {
  /** The person signed in to OpenOrc on this Mac; null with nobody signed in, or no account here. */
  "account.person": z.object({}).strict(),
};

export interface CloudRemoteRpcResults {
  "account.person": AccountPerson | null;
}

/**
 * What a session that shares cloud threads may call besides REMOTE_METHODS. Default deny like that list, with a guard
 * and a shaped reply per method in the core: the person's spaces, a space's projects, who the person is, and who is at
 * work in a cloud thread and who wrote what in it.
 */
export const CLOUD_REMOTE_METHODS = [
  "spaces.status",
  "spaces.projects",
  "account.person",
  "threads.collaboration",
  "threads.authors",
  // Starts the reader's own paused message as their own turn.
  "threads.startQueued",
] as const satisfies readonly RpcMethod[];
export type CloudRemoteMethod = (typeof CLOUD_REMOTE_METHODS)[number];

const cloudRemoteMethods: ReadonlySet<string> = new Set(CLOUD_REMOTE_METHODS);
export const isCloudRemoteMethod = (method: string): method is CloudRemoteMethod => cloudRemoteMethods.has(method);

/** What such a session may read of an OpenOrc Cloud thread. */
export const CLOUD_THREAD_READS = [
  "threads.get",
  "threads.messages",
  "threads.lastMessage",
  "runs.listForThread",
  "events.page",
  "threads.collaboration",
  "threads.authors",
] as const satisfies readonly RoutedMethod[];

/**
 * What such a session may change in an OpenOrc Cloud thread, as the person signed in on the Mac: start one, send, queue,
 * take a waiting message back, start a paused one, stop a turn, answer an ask, and keep the thread as its windows do.
 * Stop and an answer must name the turn and the ask the phone saw, and a send into a running turn names its turn: a
 * phone's screen is always a moment behind the Mac. Sending a queued message now is left to the Mac, which sees the
 * turn it would join.
 */
export const CLOUD_THREAD_WRITES = [
  "threads.start",
  "runs.start",
  "runs.send",
  "threads.queue",
  "threads.unqueue",
  "threads.startQueued",
  "runs.interrupt",
  "approvals.resolve",
  "threads.update",
] as const satisfies readonly RoutedMethod[];
