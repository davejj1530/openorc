import { useContext, useEffect, useState } from "react";
import { ConversationVoice } from "../lib/turn-authors";
import { workDuration } from "@openorc/client";
import { AgentOrb } from "./AgentOrb";

/** Seconds since `since`, ticking only while `active`; a resting orb needs no timer. */
function useElapsed(active: boolean, since: number | undefined): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active && since !== undefined ? workDuration(Math.max(1000, now - since)) : null;
}

/**
 * Whoever is on the other end, at the tail of the conversation. It does not
 * come and go with a turn: it rests between them and stirs while one runs, so
 * the conversation always ends in the agent rather than in whatever step
 * happened last. A turn's head says how long it has been going; a team, whose
 * turns have no head, passes `since` for the clock here.
 */
export function AgentPresence({ working, since }: { working: boolean; since?: number | undefined }) {
  const elapsed = useElapsed(working, since);
  const { face } = useContext(ConversationVoice);
  return (
    <div className="transcript-block agent-presence" data-state={working ? "running" : "idle"} role="status">
      {face ? face(working) : <AgentOrb state={working ? "thinking" : "idle"} />}
      {elapsed ? <span>Working for {elapsed}</span> : null}
    </div>
  );
}
