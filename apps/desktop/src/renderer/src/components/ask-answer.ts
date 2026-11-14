import { docks, type Block } from "@openorc/client";
import type { RpcParams } from "@openorc/protocol";
import { createContext, useContext, useState } from "react";
import { core } from "../lib/rpc";

/** Why the asks in a conversation can't be answered now, as when the thread's place can't be reached; null when they can. */
export const AnswersBlocked = createContext<string | null>(null);

/** Whether this conversation's composer takes its waiting asks, so they show there and not where they were asked. */
export const AsksDocked = createContext(false);

/** Which blocks are asks that wait on the composer rather than where they were asked. */
export function useDockedAsks(): (block: Block) => boolean {
  const docked = useContext(AsksDocked);
  return (block) => docked && block.kind === "approval" && !block.decision && docks(block);
}

/**
 * Answering one ask from its own card: the answer goes once, its card shows it is on its way, and a refusal reads on
 * the card that was acted on. `blocked` is why no answer can go now.
 */
export function useAskAnswer(runId: string, approvalId: string) {
  const [state, setState] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });
  const blocked = useContext(AnswersBlocked);
  const answer = (decision: RpcParams<"approvals.resolve">["decision"], answers?: Record<string, string[]>) => {
    setState({ pending: true, error: null });
    Promise.resolve(core.call("approvals.resolve", { runId, approvalId, decision, ...(answers && { answers }) })).then(
      () => setState({ pending: false, error: null }),
      (error: unknown) => setState({ pending: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  return { answer, pending: state.pending, blocked, error: state.error };
}
