import { z } from "zod";

/**
 * What is left on the wire of the person's own cloud, which this app no longer has. Phone builds from before its removal
 * ask a Mac once a session whether it offers cloud threads. A Mac of today answers `offered: false` with no provider and
 * no brain, and such a phone then offers no cloud place and forgets the brain it saved for that Mac. The fuller answers
 * are an older Mac's, which a phone of today still reads to know whose brain a saved one is.
 */
export interface CloudOffer {
  offered: boolean;
  /** Where a new cloud thread would have run; null from a Mac of today. */
  provider: "local" | "vercel" | "agent37" | null;
  /** The cloud brain an older Mac set up; absent from a Mac of today. */
  brain?: CloudBrainOffer | null;
}

/** An older Mac's cloud brain, named for its phones. */
export interface CloudBrainOffer {
  /** The brain's link key, base64url: the id a phone paired with it saved it under. */
  host: string | null;
  projects: { mac: string; cloud: string }[];
}

export const cloudRpcParams = {
  "cloud.offer": z.object({}),
};

export interface CloudRpcResults {
  "cloud.offer": CloudOffer;
}
