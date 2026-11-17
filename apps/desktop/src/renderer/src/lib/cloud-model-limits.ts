import { HOSTED_AGENTS, type HarnessId } from "@openorc/protocol";

/** What a model picker offers for a turn on OpenOrc Cloud: the agents it runs, and no fast mode. */
export const CLOUD_MODEL_LIMITS: { harnesses: readonly HarnessId[]; fast: false } = { harnesses: HOSTED_AGENTS, fast: false };
