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

/**
 * A Mac that shares it gets a phone a session of OpenOrc Cloud of its own, for the person signed in on that Mac, and
 * tells the phone when that changes (`CLOUD_SESSION_TAG`): the phone then reads the cloud itself, not through the Mac.
 */
export const CLOUD_SESSION = "cloud-session";
export const supportsCloudSession = (capabilities: readonly string[] = []): boolean => capabilities.includes(CLOUD_SESSION);

/** Invalidated, for sessions that share `CLOUD_SESSION` only, when the person signed in on the Mac signs out or changes. */
export const CLOUD_SESSION_TAG = "cloud.session";

/** Whose OpenOrc Cloud the Mac is signed in to: its server, and the account by its address. */
export interface CloudSessionOwner {
  server: string;
  email: string;
}

/** A one-time code for the phone's own session, bound to the challenge it sent; it finishes it with its verifier. */
export interface CloudSessionGrant extends CloudSessionOwner {
  request: string;
  code: string;
  expiresInMs: number;
}

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
 * and a shaped reply per method in the core: the person's spaces, a space's projects, who the person is, who is at
 * work in a cloud thread and who wrote what in it, the moves that release a turn its handoff holds, and its notes.
 */
export const CLOUD_REMOTE_METHODS = [
  "spaces.status",
  "spaces.projects",
  "account.person",
  "threads.collaboration",
  "threads.authors",
  // Starts the reader's own paused message as their own turn.
  "threads.startQueued",
  // A handoff's moves: retry the save that failed, stop the work or a command the last turn left running.
  "threads.retrySave",
  "threads.stopWork",
  "threads.stopCommand",
  // A cloud thread's notes, marking read those that tag the reader once they see them, and posting one that tags people.
  "threads.notes",
  "threads.readNotes",
  "threads.people",
  "threads.postNote",
  // A cloud thread's work: what its server serves of it, its changes, a file's diff, its commits, where it stands on
  // GitHub, and commit, push or a pull request.
  "hosted.capabilities",
  "hosted.review.changes",
  "hosted.review.file",
  "hosted.review.commits",
  "hosted.review.commit",
  "hosted.review.state",
  "hosted.review.action",
  // Deleting a cloud thread, for everyone in it. A thread of the Mac's is never deleted from a phone.
  "threads.delete",
  // The organization's team chat, as the person's own window has it. The server decides each call; a message that calls
  // the person's Orcling runs it on this Mac, which holds it.
  "teamChat.state",
  "teamChat.openDm",
  "teamChat.conversation",
  "teamChat.createChannel",
  "teamChat.joinChannel",
  "teamChat.leaveChannel",
  "teamChat.addMembers",
  "teamChat.removeMember",
  "teamChat.timeline",
  "teamChat.watch",
  "teamChat.unwatch",
  "teamChat.send",
  "teamChat.react",
  "teamChat.pins",
  "teamChat.pin",
  "teamChat.search",
  "teamChat.seen",
  "teamChat.unreadSpaces",
  "teamChat.presence",
  "teamChat.orclingCall",
  "teamChat.retryOrclingCall",
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
  "events.toolOutput",
  "threads.collaboration",
  "threads.authors",
  "threads.notes",
  "threads.people",
  "hosted.capabilities",
  "hosted.review.changes",
  "hosted.review.file",
  "hosted.review.commits",
  "hosted.review.commit",
  "hosted.review.state",
] as const satisfies readonly RoutedMethod[];

/**
 * What such a session may change in an OpenOrc Cloud thread, as the person signed in on the Mac: start one, send, queue,
 * take a waiting message back, start a paused one, stop a turn, answer an ask, release a turn a handoff holds, post a
 * note and mark notes read, commit, push or open a pull request, delete it, and keep the thread as its windows do. Stop
 * and an answer must name the turn and the ask the phone saw, and a send into a running turn names its turn: a phone's
 * screen is always a moment behind the Mac. Sending a queued message now is left to the Mac, which sees the turn it
 * would join.
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
  "threads.retrySave",
  "threads.stopWork",
  "threads.stopCommand",
  "threads.readNotes",
  "threads.postNote",
  "hosted.review.action",
  "threads.delete",
] as const satisfies readonly RoutedMethod[];
