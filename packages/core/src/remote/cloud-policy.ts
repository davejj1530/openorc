import type { HostedThreads } from "@openorc/hosted";
import { CLOUD_THREAD_READS, CLOUD_THREAD_WRITES, type CloudRemoteMethod, type RoutedMethod, type RpcParams, type RpcResults, type SpacesStatus } from "@openorc/protocol";
import type { PhoneShaping } from "./phone-words.js";
import { NOT_FROM_PHONE } from "./policy.js";

/*
 * What a phone whose session shares cloud threads may ask of the account signed in on this Mac. It acts as that
 * person, so the server's own answer is the permission; this is least privilege on top, as policy.ts is for the Mac:
 * the spaces, a space's projects and threads, reading a cloud thread, and the changes a conversation needs.
 */

const cloudReads: ReadonlySet<string> = new Set(CLOUD_THREAD_READS);
const cloudWrites: ReadonlySet<string> = new Set(CLOUD_THREAD_WRITES);

/** A phone's images are files of this Mac, which a cloud thread cannot read. */
export const NO_CLOUD_FILES = "Files can't be sent to a cloud thread from a phone yet.";

/**
 * Why a phone's change to a cloud thread stops here, before the server hears of it; null lets it on to the server,
 * which decides as it does for the person's own window. Stop and an answer go on only with the turn and the ask the
 * phone saw: unnamed, they would take whatever turn or ask the Mac holds a moment later, which may be another person's.
 */
function phoneWriteRefusal(method: string, params: Record<string, unknown>): string | null {
  if (!cloudWrites.has(method)) return NOT_FROM_PHONE;
  if (Array.isArray(params["attachments"]) && params["attachments"].length > 0) return NO_CLOUD_FILES;
  if (method === "runs.interrupt") return typeof params["expectedTurnId"] === "string" ? null : NOT_FROM_PHONE;
  if (method === "approvals.resolve") return typeof params["expectedState"] === "string" && typeof params["expectedTurnId"] === "string" ? null : NOT_FROM_PHONE;
  return null;
}

/**
 * OpenOrc Cloud as a phone's requests meet it: the place the windows ask, cut down to what a phone may read and change.
 * A thread, run or project is held exactly as for a window, so a cloud id is never answered from this Mac. Its rows
 * join a list only for the space a request names, so a list that names none stays this Mac's. Every other call about a
 * cloud thread is refused here, before the server hears of it.
 */
export function phoneCloudPlace(place: HostedThreads): HostedThreads {
  return {
    brain: place.brain,
    get active() {
      return place.active;
    },
    holds: (ref) => place.holds(ref),
    project: (id) => place.project(id),
    listed: (method, params) => ("spaceId" in params && typeof params.spaceId === "string" ? place.listed(method, params) : null),
    call: <M extends RoutedMethod>(method: M, params: RpcParams<M>) => {
      const refusal = cloudReads.has(method) ? null : phoneWriteRefusal(method, params as Record<string, unknown>);
      return refusal ? Promise.reject(new Error(refusal)) : place.call(method, params);
    },
  };
}

type Reply<M extends CloudRemoteMethod> = (result: RpcResults[M], context: PhoneShaping) => RpcResults[M];
const same = <T>(result: T): T => result;

/** The person's spaces and their access to them. The server's address, who invited them where and whether they may found an organization stay on the Mac. */
function phoneSpaces(status: SpacesStatus, { words }: PhoneShaping): SpacesStatus {
  if (status.state === "loading") return { ...status, error: status.error === null ? null : words(status.error) };
  if (status.state !== "ready") return status;
  return { ...status, apiOrigin: "", invitations: [], create: { allowed: false, reason: null }, error: status.error === null ? null : words(status.error) };
}

/**
 * What a phone hears of each result, typed over CLOUD_REMOTE_METHODS so a method added later must say how it is shaped.
 * None needs a guard of its own: each takes a space's or a thread's id and nothing else, which its schema holds it to.
 */
const cloudReplies: { [M in CloudRemoteMethod]: Reply<M> } = {
  "spaces.status": phoneSpaces,
  // Names, repositories and ids; a project's folder on this Mac is named by its id alone.
  "spaces.projects": same,
  // The handler gives a name and a picture alone.
  "account.person": same,
  // People by id, name and picture, as the server gives them to everyone in the thread. No mail, plan or balance.
  "threads.collaboration": same,
  "threads.authors": same,
  // The queue as it now stands: messages' own words and their state.
  "threads.startQueued": same,
  // Nothing comes back from a handoff's moves.
  "threads.retrySave": same,
  "threads.stopWork": same,
  "threads.stopCommand": same,
  // Notes as the server gives them to everyone in the thread: words, tags and their authors by name and picture.
  "threads.notes": same,
  "threads.readNotes": same,
};

export function cloudReply<M extends CloudRemoteMethod>(method: M, result: RpcResults[M], context: PhoneShaping): RpcResults[M] {
  return (cloudReplies[method] as Reply<M>)(result, context);
}
