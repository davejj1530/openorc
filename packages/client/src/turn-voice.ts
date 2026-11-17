import type { ThreadPerson } from "@openorc/protocol";

/** Who speaks in a turn: the agent and model its run spoke with, and the byline of a guest that spoke in it. */
export interface TurnVoice {
  agent: string;
  model: string | null;
  byline?: string | undefined;
}

/**
 * Whether a turn names who spoke in it: only where that changed, so a thread that stays on one agent and model names
 * it on no turn and a switch shows on the turn it happened. `before`: the voice of the turn before, or for the first
 * turn the thread's own, which its composer names.
 */
export function turnShowsVoice(voice: TurnVoice | undefined, before: TurnVoice | undefined): boolean {
  if (!voice || !before) return false;
  return voice.agent !== before.agent || voice.model !== before.model || voice.byline !== before.byline;
}

/**
 * Whether a turn in a thread others are in names who sent it: only where its prompt does not already name them, as
 * when a teammate's message joined someone's turn or no prompt started it. Null: a former member.
 */
export function turnShowsSender(sender: ThreadPerson | null | undefined, promptAuthor: ThreadPerson | null | undefined): boolean {
  if (sender === undefined) return false;
  return promptAuthor === undefined || promptAuthor?.id !== sender?.id;
}
