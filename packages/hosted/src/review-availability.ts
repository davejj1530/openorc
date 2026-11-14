import { HOSTED_REASONS, HostedReviewState } from "@openorc/protocol";
import { Refused, Unreadable, type Requests } from "./session.js";
import { ROUTES, type Route } from "./wire.js";
import { PARITY_ROUTES } from "./wire-parity.js";

/** A missing route on a readable older thread is unavailable, not an empty change record or a broken URL. */
export async function readReview<T>(on: Requests, threadId: string, route: Route<T>): Promise<T> {
  try {
    return await on.request(route);
  } catch (error) {
    if (!(error instanceof Refused) || error.status !== 404) throw error;
    await on.request(ROUTES.thread(threadId));
    throw new Refused(HOSTED_REASONS.changes);
  }
}

export async function readPublishing(on: Requests, threadId: string): Promise<HostedReviewState> {
  const detail = await on.request(PARITY_ROUTES.readableThread(threadId));
  if (!("work" in detail)) throw new Refused(HOSTED_REASONS.publishing);
  const parsed = HostedReviewState.safeParse(detail);
  if (!parsed.success) throw new Unreadable();
  return parsed.data;
}
