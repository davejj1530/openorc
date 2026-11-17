import { createContext, useContext } from "react";

/** Who answered in a run: its agent, and its model as the catalog names it. */
export interface Voice {
  agent: string;
  model: string | null;
}

/** Each run's voice in the open thread, and the thread's own, which its composer names and a run it does not know takes. */
export interface Voices {
  runs: ReadonlyMap<string, Voice>;
  own: Voice | undefined;
}

export const NO_VOICES: Voices = { runs: new Map(), own: undefined };

/** The open thread's voices, for turn heads and question cards. */
export const VoicesContext = createContext<Voices>(NO_VOICES);

export const voiceOf = (voices: Voices, runId: string): Voice | undefined => voices.runs.get(runId) ?? voices.own;

export function useVoice(runId: string): Voice | undefined {
  return voiceOf(useContext(VoicesContext), runId);
}
