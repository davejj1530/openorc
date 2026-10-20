import { createContext, useContext, type ReactNode } from "react";

/** The agent a run spoke with and the display name of its model, for a turn's head. */
export interface RunVoice {
  agent: string;
  model: string | null;
}

/**
 * Who speaks in a conversation, for the transcript: bylines for runs a guest spoke in, by run id, and the face
 * resting at the conversation's tail when an Orcling works there. Without it, turns go unnamed and the orb rests.
 * `runs` names the agent and model of each run; `agent` stands in for turns whose run is unknown, such as messages
 * saved with the thread.
 */
export interface ConversationVoice {
  authors: ReadonlyMap<string, string>;
  face?: ((working: boolean) => ReactNode) | undefined;
  runs?: ReadonlyMap<string, RunVoice> | undefined;
  agent?: RunVoice | undefined;
}

export const ConversationVoice = createContext<ConversationVoice>({ authors: new Map() });

/** A turn's byline: the name its caller gave, else who spoke in its run. */
export function useTurnAuthor(named: string | undefined, runId: string): string | undefined {
  const { authors } = useContext(ConversationVoice);
  return named ?? authors.get(runId);
}

/** The agent and model a turn's run spoke with, when the conversation knows them. */
export function useRunVoice(runId: string): RunVoice | undefined {
  const { runs, agent } = useContext(ConversationVoice);
  return runs?.get(runId) ?? agent;
}
