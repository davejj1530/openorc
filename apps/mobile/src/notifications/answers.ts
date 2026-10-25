import { useEffect, useState } from "react";

export type AlertAnswer = "allow" | "deny";

/** The approval an answer is for. Approval ids alone repeat: Codex numbers its requests in every run, on every Mac. */
export interface AnswerFor {
  macId: string;
  runId: string;
  approvalId: string;
}

/** How long an answer chosen on an alert waits for its thread to load. */
export const ANSWER_WITHIN_MS = 120_000;

const queued = new Map<string, { answer: AlertAnswer; at: number }>();
const listeners = new Set<() => void>();
const keyOf = ({ macId, runId, approvalId }: AnswerFor) => JSON.stringify([macId, runId, approvalId]);

/** Allow or Deny chosen on an alert, for that approval's card to send over the normal link once it is on screen. */
export function queueAnswer(approval: AnswerFor, answer: AlertAnswer, at: number): void {
  queued.set(keyOf(approval), { answer, at });
  for (const listener of listeners) listener();
}

/** The answer waiting for this approval, taken so it is sent at most once; null once it waited too long. */
export function takeQueued(approval: AnswerFor, now: number): AlertAnswer | null {
  const key = keyOf(approval);
  const entry = queued.get(key);
  for (const [id, { at }] of queued) if (now - at > ANSWER_WITHIN_MS) queued.delete(id);
  if (!entry || now - entry.at > ANSWER_WITHIN_MS) return null;
  queued.delete(key);
  return entry.answer;
}

function peekQueued(approval: AnswerFor, now: number): AlertAnswer | null {
  const entry = queued.get(keyOf(approval));
  return entry && now - entry.at <= ANSWER_WITHIN_MS ? entry.answer : null;
}

/**
 * For an approval's card: the answer chosen on its alert, whether queued before the card mounted or after. It stays
 * queued until the card takes it as it sends, so a card that leaves the screen first leaves it to the one in its place.
 */
export function useQueuedAnswer(approval: AnswerFor | null): AlertAnswer | null {
  const [answer, setAnswer] = useState<AlertAnswer | null>(null);
  const { macId, runId, approvalId } = approval ?? {};
  useEffect(() => {
    if (!macId || !runId || !approvalId) return;
    const look = () => setAnswer(peekQueued({ macId, runId, approvalId }, Date.now()));
    look();
    listeners.add(look);
    return () => void listeners.delete(look);
  }, [macId, runId, approvalId]);
  return answer;
}
