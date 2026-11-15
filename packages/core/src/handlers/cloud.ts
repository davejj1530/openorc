import type { Handlers } from "./types.js";

/**
 * What is left of the person's own cloud: the one answer phones in the field still ask a Mac for. A build from before
 * the removal that hears `offered: false` with no brain offers no cloud place and forgets the brain it saved for this Mac.
 */
export function createCloudHandlers(): Pick<Handlers, "cloud.offer"> {
  return { "cloud.offer": () => ({ offered: false, provider: null }) };
}
