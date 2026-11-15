import type { Admit, Thread } from "./stand-in-threads.js";

/** Where a message goes: refused, into the running turn, or queued; paused for its author, or taken once the turn rests. */
export interface Placement {
  refusal: string | null;
  queue: boolean;
  paused: boolean;
  /** It names a turn that has ended: taken as its author's own turn when the thread rests. */
  settle?: true;
  /** Who is stopping the turn it landed on, when that is someone other than its author. */
  stoppedBy?: string | null;
}

type Settings = { agent: string; model: string | null };

/** Under the starter-only rule: into the running turn, after it, or a new turn if admitted. */
export function placeOwn(admit: Admit, thread: Thread, who: string, settings: Settings, after: boolean): Placement {
  const refusal = thread.turn ? null : admit(who, settings);
  return { refusal: after && thread.turn ? null : refusal, queue: Boolean(thread.turn) && after, paused: false };
}

/**
 * Where a message goes once shared writing is open: Send now joins the turn it names, on that turn's sender, asking
 * nothing of its author; one naming a turn that is gone or another waits as its author's own; Queue and a new turn
 * need the author's own admission; a turn stopping takes nothing, so the message waits paused.
 */
export function placeShared(
  rules: { admit: Admit; joinsOnly(thread: Thread, who: string): boolean },
  thread: Thread,
  who: string,
  body: Record<string, unknown>,
  settings: Settings,
  after: boolean,
): Placement {
  const expected = typeof body["expectedTurnId"] === "string" ? body["expectedTurnId"] : null;
  if (thread.stopping) return whileStopping(thread, who, Boolean(expected) && !after);
  if (thread.turn && !after && (!expected || expected === thread.turnId)) return { refusal: null, queue: false, paused: false };
  // Its turn ended or changed before it arrived: it waits as the author's own. While only joining is open it waits
  // paused, since nothing a teammate sends may start a turn; else it is admitted as theirs when it is taken.
  if (expected && !after && rules.joinsOnly(thread, who)) return { refusal: null, queue: true, paused: true };
  if (thread.turn && !after) return { refusal: null, queue: true, paused: false };
  if (expected && !after) return { refusal: null, queue: true, paused: false, settle: true };
  return { refusal: rules.admit(who, settings), queue: Boolean(thread.turn), paused: false };
}

/**
 * While a turn stops: what anyone but the stopper sends waits paused for its author, a join too; the stopper's own runs
 * once the turn has ended. A stop nobody asked for pauses nothing but a join.
 */
function whileStopping(thread: Thread, who: string, joins: boolean): Placement {
  const other = thread.stoppedBy !== null && thread.stoppedBy !== who ? thread.stoppedBy : null;
  return { refusal: null, queue: true, paused: Boolean(other) || joins, stoppedBy: other };
}
