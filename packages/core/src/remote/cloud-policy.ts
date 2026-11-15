import type { HostedThreads } from "@openorc/hosted";
import { CLOUD_THREAD_READS, type CloudRemoteMethod, type RoutedMethod, type RpcParams, type RpcResults, type SpacesStatus } from "@openorc/protocol";
import type { PhoneShaping } from "./phone-words.js";
import { NOT_FROM_PHONE } from "./policy.js";

/*
 * What a phone whose session shares cloud threads may ask of the account signed in on this Mac. It acts as that
 * person, so the server's own answer is the permission; this is least privilege on top, as policy.ts is for the Mac:
 * the spaces, a space's projects and threads, and reading a cloud thread. Nothing here changes anything on the server.
 */

const cloudReads: ReadonlySet<string> = new Set(CLOUD_THREAD_READS);

/**
 * OpenOrc Cloud as a phone's requests meet it: the place the windows ask, cut down to reading. A thread, run or project
 * is held exactly as for a window, so a cloud id is never answered from this Mac. Its rows join a list only for the
 * space a request names, so a list that names none stays this Mac's. Every other call about a cloud thread is refused
 * here, before the server hears of it.
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
    call: <M extends RoutedMethod>(method: M, params: RpcParams<M>) => (cloudReads.has(method) ? place.call(method, params) : Promise.reject(new Error(NOT_FROM_PHONE))),
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
  // People by id, name and picture, as the server gives them to everyone in the thread. No mail, plan or balance.
  "threads.collaboration": same,
  "threads.authors": same,
};

export function cloudReply<M extends CloudRemoteMethod>(method: M, result: RpcResults[M], context: PhoneShaping): RpcResults[M] {
  return (cloudReplies[method] as Reply<M>)(result, context);
}
