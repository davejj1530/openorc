import { OpenOrcMark } from "./OpenOrcMark";

export type OrbState = "idle" | "thinking";

/** A quiet, flat presence mark. Only an active turn animates; reduced motion stays still. */
export function AgentOrb({ state }: { state: OrbState }) {
  return (
    <span className="agent-orb agent-presence-mark" data-state={state} aria-hidden="true">
      <OpenOrcMark size={22} />
    </span>
  );
}
