import type { Refusal } from "@openorc/link";
import type { Route } from "@openorc/protocol";

/** Timers the connection runs on, injected so tests drive them. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * One route's answer: a session, the Mac declining this phone, or nothing usable (`refused: null`). `answered`: a server
 * at the address answered the upgrade itself, with no OpenOrc host behind it.
 */
export type Answer<T> = { ok: true; value: T } | { ok: false; refused: Refusal | null; answered?: boolean };

/** One route being tried. `cancel` gives up on it, closing whatever it opened. */
export interface Attempt<T> {
  answer: Promise<Answer<T>>;
  cancel(): void;
}

export type RaceResult<T> = { ok: true; route: Route; value: T } | { ok: false; refused: Refusal | null; answered?: boolean };

export const ROUTE_STAGGER_MS = 250;
export const ROUTE_TIMEOUT_MS = 4_000;

/**
 * Tries `routes` in order: the first at once, each next one 250 ms after the one before or as soon as that one fails.
 * The first handshake to finish wins and the others are cancelled; one that finishes anyway is handed to `discard`.
 * A refusal ends the race, since every route reaches the same Mac. Each try gets 4 s unless `timeoutMs` says otherwise,
 * and `signal` calls the whole race off.
 */
export function raceRoutes<T>(
  routes: readonly Route[],
  dial: (route: Route) => Attempt<T>,
  clock: Clock,
  discard: (value: T) => void,
  { timeoutMs = ROUTE_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RaceResult<T>> {
  return new Promise((resolve) => {
    const running = new Set<Attempt<T>>();
    let next = 0;
    let stagger: unknown = null;
    let done = false;
    let answered = false;

    const finish = (result: RaceResult<T>) => {
      done = true;
      clock.clearTimeout(stagger);
      for (const attempt of running) attempt.cancel();
      running.clear();
      resolve(result);
    };

    const start = () => {
      clock.clearTimeout(stagger);
      stagger = null;
      if (done) return;
      const route = routes[next++];
      if (!route) {
        if (running.size === 0) finish({ ok: false, refused: null, ...(answered ? { answered } : {}) });
        return;
      }
      const attempt = dial(route);
      running.add(attempt);
      let settled = false;
      const settle = (answer: Answer<T>) => {
        if (settled) {
          if (answer.ok) discard(answer.value);
          return;
        }
        settled = true;
        if (!answer.ok && answer.answered) answered = true;
        clock.clearTimeout(timer);
        running.delete(attempt);
        if (done) {
          if (answer.ok) discard(answer.value);
        } else if (answer.ok) finish({ ok: true, route, value: answer.value });
        else if (answer.refused) finish({ ok: false, refused: answer.refused });
        else start();
      };
      const timer = clock.setTimeout(() => {
        attempt.cancel();
        settle({ ok: false, refused: null });
      }, timeoutMs);
      attempt.answer.then(settle, () => settle({ ok: false, refused: null }));
      if (next < routes.length) stagger = clock.setTimeout(start, ROUTE_STAGGER_MS);
    };

    if (signal?.aborted) return finish({ ok: false, refused: null });
    signal?.addEventListener("abort", () => done || finish({ ok: false, refused: null }), { once: true });
    start();
  });
}
