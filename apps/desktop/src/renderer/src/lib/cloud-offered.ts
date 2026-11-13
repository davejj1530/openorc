import { cloudStartBlocked, hostedStart, runsInCloud, targetModel, type NewThreadTarget, type StartBlock } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { useRpc } from "./client";

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
  const shown = target.kind === "model" && runsInCloud(targetModel(target)?.agent);
  const offer = useRpc("cloud.offer", {}, { enabled: shown }).data;
  const blocked = cloudStartBlocked(offer, projectId);
  return { shown, brain: Boolean(offer?.brain), blocked, can: shown && !blocked, local: offer?.provider === "local" };
}

/** OpenOrc Cloud in a new thread's place menu: offered to a person with an account, for a project's model, blocked with why it can't start there now. */
export interface NewThreadHosted {
  shown: boolean;
  blocked: StartBlock | null;
  can: boolean;
}

export function useNewThreadHosted(target: NewThreadTarget, projectId: string): NewThreadHosted {
  const account = useRpc("account.status", {}).data;
  const choice = target.kind === "model" ? targetModel(target) : null;
  const { shown, blocked } = hostedStart(account, { projectId, agent: choice?.agent ?? "", model: choice?.model ?? null });
  const offered = shown && target.kind === "model" && projectId !== WORKSPACE_ID;
  return { shown: offered, blocked, can: offered && choice !== null && !blocked };
}
