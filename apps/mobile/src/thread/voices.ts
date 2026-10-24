import { createContext, useContext } from "react";

/** Who answered in a run: its agent, and its model as the catalog names it. */
export interface Voice {
  agent: string;
  model: string | null;
}

/** Each run's voice in the open thread, for turn heads and question cards. */
export const VoicesContext = createContext<ReadonlyMap<string, Voice>>(new Map());

export function useVoice(runId: string): Voice | undefined {
  return useContext(VoicesContext).get(runId);
}
