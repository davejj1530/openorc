import { HOSTED_REASONS, HostedReviewState, type HostedCapabilities } from "@openorc/protocol";
import { Refused } from "./session.js";
import type { Threads } from "./threads.js";
import { PARITY_ROUTES } from "./wire-parity.js";
import { REVIEW_ROUTES } from "./wire-review.js";

/**
 * Availability is a requested hint. Every operation still checks its own current access. A family the server said is
 * full of subthreads holds New subthread in its words.
 */
export async function capabilities(threads: Threads, params: { threadId: string }): Promise<HostedCapabilities> {
  const answer = await served(threads, params);
  const full = threads.subthreadsFull(params.threadId);
  return full ? { ...answer, features: { ...answer.features, personSubthreads: { available: false, reason: full } } } : answer;
}

async function served(threads: Threads, { threadId }: { threadId: string }): Promise<HostedCapabilities> {
  const on = threads.on(threadId);
  try {
    return await on.request(PARITY_ROUTES.capabilities);
  } catch (error) {
    if (!(error instanceof Refused) || error.status !== 404) throw error;
  }
  // The detail read proves this is an accessible thread before a missing changes route can mean old-server absence.
  const detail = await on.request(PARITY_ROUTES.readableThread(threadId));
  const features: HostedCapabilities["features"] = { publishing: HostedReviewState.safeParse(detail).success ? { available: true } : { available: false, reason: HOSTED_REASONS.publishing } };
  try {
    await on.request(REVIEW_ROUTES.changes(threadId));
    features.changes = { available: true };
  } catch (error) {
    if (!(error instanceof Refused) || error.status !== 404) throw error;
    features.changes = { available: false, reason: HOSTED_REASONS.changes };
  }
  return { version: 1, features };
}
