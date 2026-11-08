import { defaultChoice, targetModel, type NewThreadTarget } from "@openorc/client";
import type { HarnessId } from "@openorc/protocol";
import { ensureRpc } from "./client";
import { readNewThreadDraft, writeNewThreadDraft } from "./new-thread-draft";
import { newThread } from "./router";

/** The agent's default model, or the target the draft had when the agent offers none. */
async function agentTarget(agent: HarnessId, current: NewThreadTarget): Promise<NewThreadTarget> {
  if (targetModel(current)?.agent === agent) return current;
  try {
    const choice = defaultChoice(await ensureRpc("agents.models", {}), agent);
    return choice?.agent === agent ? { kind: "model", choice } : current;
  } catch {
    return current;
  }
}

/**
 * Opens New thread in the project with `prompt` in its composer, on `agent`. Text already drafted there stays, under
 * the new prompt, so nothing typed before is lost.
 */
export async function openNewThreadWith({ projectId, agent, prompt }: { projectId: string; agent: HarnessId; prompt: string }): Promise<void> {
  const draft = readNewThreadDraft(projectId);
  const earlier = draft.prompt.trim();
  const target = await agentTarget(agent, draft.target);
  writeNewThreadDraft({ ...draft, target, prompt: earlier ? `${prompt.trimEnd()}\n\n${earlier}` : prompt });
  newThread(projectId);
}
