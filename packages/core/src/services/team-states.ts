import {
  TEAM_ACTOR_TRANSITIONS,
  TEAM_ATTEMPT_TRANSITIONS,
  TEAM_EXECUTION_TRANSITIONS,
  teamTransitionAllowed,
  type TeamActorRecord,
  type TeamActorState,
  type TeamAttemptRecord,
  type TeamAttemptState,
  type TeamExecutionRecord,
  type TeamExecutionState,
} from "@openorc/protocol";

/**
 * The only way team state changes: each step is checked against the protocol's transition tables, so an
 * impossible move fails where it is made instead of surfacing later as a confusing journal.
 */
function step<S extends string>(transitions: Readonly<Record<S, readonly S[]>>, subject: string, from: S, to: S): S {
  if (!teamTransitionAllowed(transitions, from, to)) throw new Error(`${subject} cannot move from ${from} to ${to}.`);
  return to;
}

export function moveActor(actor: TeamActorRecord, to: TeamActorState): void {
  actor.state = step(TEAM_ACTOR_TRANSITIONS, `Team member ${actor.id}`, actor.state, to);
}

export function moveAttempt(attempt: TeamAttemptRecord, to: TeamAttemptState): void {
  attempt.state = step(TEAM_ATTEMPT_TRANSITIONS, `Team turn ${attempt.id}`, attempt.state, to);
}

export function moveExecution(record: TeamExecutionRecord, to: TeamExecutionState): void {
  record.state = step(TEAM_EXECUTION_TRANSITIONS, `Team execution ${record.id}`, record.state, to);
}
