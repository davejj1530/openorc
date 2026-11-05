import { cloudStartBlocked, runsInCloud, targetModel, type NewThreadTarget } from "@openorc/client";
import { useRpc } from "./client";

/** Cloud threads are offered in development and QA builds until they ship. */
export const cloudOffered = import.meta.env.DEV || __OPENORC_QA__;

/**
 * Cloud in a new thread's place menu: shown for a model that runs in a sandbox; with a cloud brain set up, where the
 * thread starts, blocked with its reason for a project the brain has no copy of.
 */
export interface NewThreadCloud {
  shown: boolean;
  brain: boolean;
  blocked: string | null;
  can: boolean;
  /** Cloud threads are simulated on this Mac, with its own sign-ins. */
  local: boolean;
}

export function useNewThreadCloud(target: NewThreadTarget, projectId: string): NewThreadCloud {
  const shown = cloudOffered && target.kind === "model" && runsInCloud(targetModel(target)?.agent);
  const offer = useRpc("cloud.offer", {}, { enabled: shown }).data;
  const blocked = cloudStartBlocked(offer, projectId);
  return { shown, brain: Boolean(offer?.brain), blocked, can: shown && !blocked, local: offer?.provider === "local" };
}
