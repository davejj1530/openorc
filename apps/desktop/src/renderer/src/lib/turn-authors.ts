import { createContext, useContext, type ReactNode } from "react";

/**
 * Who speaks in a conversation, for the transcript: bylines for runs a guest spoke in, by run id, and the face
 * resting at the conversation's tail when an Orcling works there. Without it, turns go unnamed and the orb rests.
 */
export interface ConversationVoice {
  authors: ReadonlyMap<string, string>;
  face?: ((working: boolean) => ReactNode) | undefined;
}

export const ConversationVoice = createContext<ConversationVoice>({ authors: new Map() });

/** A turn's byline: the name its caller gave, else who spoke in its run. */
export function useTurnAuthor(named: string | undefined, runId: string): string | undefined {
  const { authors } = useContext(ConversationVoice);
  return named ?? authors.get(runId);
}
