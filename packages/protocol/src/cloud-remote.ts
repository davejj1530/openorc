import type { RoutedMethod } from "./owners.js";
import { PHONE_CAPABILITIES } from "./phone-compatibility.js";
import type { RpcMethod } from "./rpc.js";

/**
 * A Mac that shares it serves a phone the spaces and OpenOrc Cloud threads of the person signed in on that Mac. A
 * session that does not share it is served the Mac alone, as phones always were. It says the Mac has the methods,
 * never that the person may read something: the server answers that on every call.
 */
export const CLOUD_THREADS = "cloud-threads";
export const supportsCloudThreads = (capabilities: readonly string[] = []): boolean => capabilities.includes(CLOUD_THREADS);

/** What a Mac shares with a session that asks for it: what this version's phone asks for, and cloud threads, which it does not ask for yet. */
export const MAC_CAPABILITIES = [...PHONE_CAPABILITIES, CLOUD_THREADS] as const;

/**
 * What a session that shares cloud threads may call besides REMOTE_METHODS. Default deny like that list, with a guard
 * and a shaped reply per method in the core: the person's spaces, a space's projects, and who is at work in a cloud
 * thread and who wrote what in it.
 */
export const CLOUD_REMOTE_METHODS = ["spaces.status", "spaces.projects", "threads.collaboration", "threads.authors"] as const satisfies readonly RpcMethod[];
export type CloudRemoteMethod = (typeof CLOUD_REMOTE_METHODS)[number];

const cloudRemoteMethods: ReadonlySet<string> = new Set(CLOUD_REMOTE_METHODS);
export const isCloudRemoteMethod = (method: string): method is CloudRemoteMethod => cloudRemoteMethods.has(method);

/** Every call such a session may make about an OpenOrc Cloud thread. All are reads: a phone changes nothing there yet. */
export const CLOUD_THREAD_READS = [
  "threads.get",
  "threads.messages",
  "threads.lastMessage",
  "runs.listForThread",
  "events.page",
  "threads.collaboration",
  "threads.authors",
] as const satisfies readonly RoutedMethod[];
