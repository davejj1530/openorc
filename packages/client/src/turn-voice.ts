import type { ThreadPerson } from "@openorc/protocol";

/** Who speaks in a turn: the agent its run spoke with, and the byline of a guest that spoke in it. */
export interface TurnVoice {
  agent: string;
  byline?: string | undefined;
}

/**
 * Whether a turn names who spoke in it: only where the agent or the guest speaking changed, so a thread that stays on
 * one agent names it on no turn. A change of model names nothing: the composer already says which model works.
 * `before`: the voice of the turn before, or for the first turn the thread's own.
 */
export function turnShowsVoice(voice: TurnVoice | undefined, before: TurnVoice | undefined): boolean {
  if (!voice || !before) return false;
  return voice.agent !== before.agent || voice.byline !== before.byline;
}

/**
 * Whether a turn in a thread others are in names who sent it: only where its prompt does not already name them, as
 * when a teammate's message joined someone's turn or no prompt started it. Null: a former member.
 */
export function turnShowsSender(sender: ThreadPerson | null | undefined, promptAuthor: ThreadPerson | null | undefined): boolean {
  if (sender === undefined) return false;
  return promptAuthor === undefined || promptAuthor?.id !== sender?.id;
}
