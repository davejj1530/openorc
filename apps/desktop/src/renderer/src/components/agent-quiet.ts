import type { ThreadSummary } from "@openorc/protocol";

/**
 * How long the agent may be silent before the row strengthens.
 *
 * Silence shorter than this is routine: a model composing between tool calls, a
 * dependency install, a test run. Past it, silence is unusual enough to be worth
 * noticing on a glance. It sits exactly one minute past QUIET_FLOOR_MS, so the
 * indicator has one quiet minute reading "1m" before it strengthens; a row never
 * appears already strengthened.
 */
export const QUIET_EMPHASIS_MS = 120_000;

/**
 * Below this the indicator does not render at all.
 *
 * A healthily streaming agent stamps an event roughly every second, so without
 * a floor every working row would sit at "no output for 0s" and tick forever,
 * which is churn carrying no information. Absence is the signal: no indicator
 * means the agent is producing output.
 *
 * This is deliberately the same number as the display's precision boundary, and
 * the two are not independently tunable. Because the floor is a minute, the
 * rendered string is always in whole minutes and changes only once a minute,
 * which is what lets the clock run at a single slow rate. Moving this below a
 * minute reintroduces a per-second tick for a reading that says nothing.
 */
export const QUIET_FLOOR_MS = 60_000;

/**
 * How often the clock re-reads the time. The string changes once a minute, so
 * this only has to be fine enough that a row is not visibly late crossing the
 * floor or the emphasis threshold.
 */
export const QUIET_TICK_MS = 15_000;

export interface AgentQuiet {
  /** Milliseconds since the agent last produced output. */
  ms: number;
  /** Past the emphasis threshold. The row strengthens; it does not diagnose. */
  strong: boolean;
}

/**
 * The age of the agent's silence, or null when there is nothing honest to say.
 *
 * Null covers two different situations on purpose, because the interface's
 * answer to both is the same: show nothing.
 *
 * - Not running. A session stays open between turns, so `lastAgentEventAt` is
 *   non-null and ages forever on a perfectly healthy idle thread. Non-null does
 *   not mean a run is in flight. This also keeps `waiting` out: no events flow
 *   while an approval is pending, so the number would grow while the agent is
 *   correctly blocked on the user.
 * - Running, with a timestamp, but silent for less than the floor. A streaming
 *   agent is never quiet for long, and a reading that small is churn.
 * - Running with no timestamp. A team execution can read active while no
 *   attempt holds a live run, so there is no run whose silence we could measure.
 *   That is "cannot judge", not "healthy", and a zero or a dash would read as
 *   the latter.
 */
export function agentQuiet(thread: ThreadSummary, now: number): AgentQuiet | null {
  if (thread.activity !== "running") return null;
  if (thread.lastAgentEventAt === null) return null;
  // Before the first event this is the run's start time, deliberately, so a
  // provider that hangs during boot ages instead of reading as absent.
  const ms = Math.max(0, now - thread.lastAgentEventAt);
  if (ms < QUIET_FLOOR_MS) return null;
  return { ms, strong: ms >= QUIET_EMPHASIS_MS };
}

/**
 * "1m", "6m". Only ever called past the floor, so the reading is always in whole
 * minutes and there is no seconds branch to go stale.
 */
export function formatQuiet(ms: number): string {
  return `${Math.floor(ms / QUIET_FLOOR_MS)}m`;
}
