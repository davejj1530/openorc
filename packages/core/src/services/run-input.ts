import type { ThreadActivity } from "@openorc/protocol";
import type { LiveRun } from "./run-types.js";

/** A live run as a message would find it: the run, whether OpenOrc is closing, and whether its context is compacting. */
export interface RunInput {
  entry: LiveRun | undefined;
  closing: boolean;
  compacting: boolean;
}

/** A message joins the turn that is running. */
export function steerable({ entry, closing, compacting }: RunInput): boolean {
  return !closing && Boolean(entry && entry.busy && !entry.exiting && !entry.closingRequested && !entry.failed && !compacting && entry.handle.canSteer);
}

/** A message reaches the run now: into its running turn, or as its next turn while it rests between turns. */
export function deliverable({ entry, closing, compacting }: RunInput): boolean {
  if (!entry || closing || entry.exiting || entry.closingRequested || entry.failed || compacting || entry.handle.compacting) return false;
  return entry.busy ? entry.handle.canSteer : true;
}

/**
 * Whether the thread's next queued message can go now: nothing is at work, or the turn ended while background work
 * the agent left running carries on. That work holds the queue only when the message would need a new process,
 * which would end it.
 */
export function takesQueued(activity: ThreadActivity, input: RunInput | undefined, reusable: () => boolean): boolean {
  if (activity === "idle") return true;
  if (activity === "waiting" || !input?.entry || input.entry.busy || !deliverable(input)) return false;
  return reusable();
}

/** Why a message can't join the running turn, or null when it can. */
export function steerBlocker({ entry, closing, compacting }: RunInput): string | null {
  if (!entry || entry.exiting || entry.closingRequested || entry.failed || closing) return "The provider is unavailable. Input is retained for the next turn.";
  if (compacting || entry.handle.compacting) return "The provider is compacting context. Input will follow when it is ready.";
  if (!entry.busy) return "The provider is between turns. Input is retained for the next turn.";
  if (!entry.handle.canSteer) return "The provider is starting or cannot accept live input. Input is retained until it is ready.";
  return null;
}
