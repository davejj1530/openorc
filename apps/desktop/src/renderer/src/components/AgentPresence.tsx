import { useContext, useEffect, useState } from "react";
import { ConversationVoice } from "../lib/turn-authors";
import { AgentOrb } from "./AgentOrb";

/**
 * Whoever is on the other end, at the tail of the conversation. It does not
 * come and go with a turn: it rests between them and stirs while one runs, so
 * the conversation always ends in the agent rather than in whatever step
 * happened last. The row above says which step is live; this says the turn is
 * not over and how long it has been going.
 *
 * The clock only ticks while a turn runs; a resting orb needs no timer.
 */
export function AgentPresence({ working, since, showElapsed = true }: { working: boolean; since: number; showElapsed?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const seconds = Math.max(1, Math.round((now - since) / 1000));
  const { face } = useContext(ConversationVoice);
  return (
    <div className="transcript-block mt-3 flex items-center gap-2 text-sm text-ink-3" data-state={working ? "running" : "idle"} role="status">
      {face ? face(working) : <AgentOrb state={working ? "thinking" : "idle"} />}
      {working && showElapsed ? <span>Working for {seconds}s</span> : null}
    </div>
  );
}
