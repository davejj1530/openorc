import type { Orcling, Run, ThreadSummary } from "@openorc/protocol";
import { useRpc } from "./client";
import { createContext, useContext, useMemo, type ReactNode } from "react";

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
  /** An Orcling chat, its own or a group's: its transcript reads as texting. */
  chat?: OrclingChatSpec | undefined;
  face?: ((working: boolean) => ReactNode) | undefined;
  runs?: ReadonlyMap<string, RunVoice> | undefined;
  agent?: RunVoice | undefined;
}

/** An Orcling's own conversation, or a group chat of Orclings, as the chat view draws it. */
export interface OrclingChatSpec {
  threadId: string;
  /** Who can speak here: the Orcling whose chat it is, or the group's members. */
  members: Orcling[];
  /** Which Orcling spoke in each run. */
  speakers: ReadonlyMap<string, Orcling>;
  group: boolean;
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

/** Each run's agent and model for the turn heads, with the thread's own for messages saved without a run. */
export function useRunVoices(voice: ConversationVoice, runs: readonly Run[], thread: ThreadSummary | null): ConversationVoice {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  return useMemo(() => {
    const named = (agent: string, model: string | null) => ({ agent, model: model ? (models.data?.find((option) => option.agent === agent && option.id === model)?.label ?? model) : null });
    return {
      ...voice,
      runs: new Map(runs.map((run) => [run.id, named(run.agent, run.model)])),
      agent: thread ? named(thread.agent, thread.model) : undefined,
    };
  }, [voice, runs, thread, models.data]);
}
