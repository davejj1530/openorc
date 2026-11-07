import { AsyncLocalStorage } from "node:async_hooks";
import { ROUTED_READS } from "@openorc/protocol";

/** Who asked, set by RemoteSession only and never on the wire. A window's request has no origin. */
export type RequestOrigin = { kind: "phone"; deviceId: string };

/** The device id the brain's owner, its Mac, is known by: no phone's id is ever this. */
export const OWNER_DEVICE = "owner";

/**
 * What the brain's owner asks as bookkeeping, never a reason to stay up: every read of a thread, run or task, since a
 * window reads those again on timers and after each change on the Mac (a wake for a person's own read counts as use
 * itself); the memory, open tasks and text generation choice the Mac sends while both are awake; and the list of its
 * sandboxes, which Settings reads every 30 seconds while it is open and would otherwise keep the brain up for good.
 */
const OWNER_BOOKKEEPING = new Set<string>([...ROUTED_READS, "brain.memory.exchange", "brain.backlog", "brain.textGeneration", "cloud.sandboxes"]);

/** Whether a request is someone using this host, which keeps a cloud brain awake. */
export function usesHost(method: string, origin: RequestOrigin | undefined): boolean {
  return !(origin?.deviceId === OWNER_DEVICE && OWNER_BOOKKEEPING.has(method));
}

/** The origin of the request being handled, carried across every await of its handler. */
export const requestOrigin = new AsyncLocalStorage<RequestOrigin | undefined>();

/** Audit metadata naming the phone a request came from; nothing for a window's. */
export function phoneOrigin(): { via: "phone"; device: string } | Record<string, never> {
  const origin = requestOrigin.getStore();
  return origin?.kind === "phone" ? { via: "phone", device: origin.deviceId } : {};
}
