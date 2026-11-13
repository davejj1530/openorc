import { cloudStartBlocked, hostedStart, targetModel, type NewThreadTarget, type StartBlock } from "@openorc/client";
import { WORKSPACE_ID, type CloudHours, type CloudProvider } from "@openorc/protocol";
import { useRpc } from "./client";

const SERVICE_NAMES: Record<CloudProvider, string | null> = { vercel: "Vercel", agent37: "Agent37", local: null };

/**
 * The person's own cloud in a new thread's place menu: offered for a model; with a cloud brain set up, where the thread
 * starts. Blocked with why for an agent that doesn't run there, a project the brain has no copy of, or no service yet.
 */
export interface NewThreadCloud {
  shown: boolean;
  brain: boolean;
  blocked: StartBlock | null;
  can: boolean;
  /** Cloud threads are simulated on this Mac, with its own sign-ins. */
  local: boolean;
  /** The service it runs on, by name, for the row's end. */
  service: string | null;
}

export function useNewThreadCloud(target: NewThreadTarget, projectId: string): NewThreadCloud {
  const agent = target.kind === "model" ? targetModel(target)?.agent : null;
  const shown = target.kind === "model";
  const offer = useRpc("cloud.offer", {}, { enabled: shown }).data;
  const blocked = shown ? cloudStartBlocked(offer, projectId, agent) : null;
  const provider = offer?.provider ?? null;
  return { shown, brain: Boolean(offer?.brain), blocked, can: shown && !blocked, local: provider === "local", service: provider ? SERVICE_NAMES[provider] : null };
}

/** OpenOrc Cloud in a new thread's place menu: offered to a person with an account, for a project's model, blocked with why it can't start there now. */
export interface NewThreadHosted {
  shown: boolean;
  blocked: StartBlock | null;
  can: boolean;
  /** The cloud hours left, for the row's end. */
  hours: CloudHours | null;
}

export function useNewThreadHosted(target: NewThreadTarget, projectId: string): NewThreadHosted {
  const account = useRpc("account.status", {}).data;
  const choice = target.kind === "model" ? targetModel(target) : null;
  const { shown, blocked } = hostedStart(account, { projectId, agent: choice?.agent ?? "", model: choice?.model ?? null });
  const offered = shown && target.kind === "model" && projectId !== WORKSPACE_ID;
  return { shown: offered, blocked, can: offered && choice !== null && !blocked, hours: account?.state === "signed-in" ? account.hours : null };
}
