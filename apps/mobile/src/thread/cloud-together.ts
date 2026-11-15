import { threadTogether } from "@openorc/client";
import type { ThreadCollaboration, ThreadSummary } from "@openorc/protocol";
import { createContext, useContext } from "react";

/*
 * Working together in an OpenOrc Cloud thread, as the open thread's screen last read it. The phone is always a moment
 * behind its Mac, so a Stop and an answer name what this screen saw: the Mac and the server refuse them when it changed,
 * rather than stop or answer whatever turn or ask came since, which may be someone else's.
 */

/** The open thread's collaboration; null for a thread of this Mac, or from a server that predates working together. */
export const TogetherContext = createContext<ThreadCollaboration | null>(null);

export const useTogether = (): ThreadCollaboration | null => useContext(TogetherContext);

export function threadTogetherOf(thread: ThreadSummary | null): ThreadCollaboration | null {
  return threadTogether(thread);
}

/** What a Stop names: the running turn this screen saw. */
export const turnSeen = (state: ThreadCollaboration | null): { expectedTurnId: string } | Record<string, never> => (state?.live ? { expectedTurnId: state.live.id } : {});

/** What an answer names: the ask in the phase this screen saw it. Nothing when the screen has not seen this ask. */
export function askSeen(state: ThreadCollaboration | null, approvalId: string): { expectedState: "waiting" | "parked"; expectedTurnId: string } | Record<string, never> {
  const ask = state?.ask;
  return ask?.id === approvalId ? { expectedState: ask.state, expectedTurnId: ask.turnId } : {};
}

/**
 * Whether this reader may answer an ask here now, and the one line that says what answering does or why they cannot,
 * in the server's words where it has them. A thread of this Mac, or an ask the screen has not seen, answers as always.
 */
export function askStanding(state: ThreadCollaboration | null, approvalId: string): { answer: boolean; decline: boolean; line: string | null } {
  if (!state) return { answer: true, decline: true, line: null };
  const ask = state.ask;
  if (ask?.id !== approvalId) return { answer: false, decline: false, line: null };
  if (ask.answer === "blocked") return { answer: false, decline: ask.canDecline, line: ask.reason };
  if (ask.answer === "start") return { answer: true, decline: true, line: "Answering starts your own turn, on your sign-in and hours." };
  return { answer: true, decline: true, line: null };
}
