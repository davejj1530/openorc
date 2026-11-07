import type { Route } from "@openorc/protocol";
import type { WakeOutcome } from "./door";
import type { Clock } from "./route-race";

/** A plain HTTPS GET: the status the address answered with, or null when nothing answered before `signal` aborted. */
export type CallAddress = (url: string, signal: AbortSignal) => Promise<number | null>;

/** Agent37 holds a call to a sleeping instance while it restores, and asks callers to wait at least three minutes. */
const WAKE_WITHIN_MS = 180_000;
/** An instance that boots afresh starts the brain from its boot hook within seconds; its address answers 502 till then. */
const START_WITHIN_MS = 30_000;
/** The pause before calling again after a call that came to nothing. */
const CALL_AGAIN_MS = 3_000;

/** The brain's listener answers a plain call 404: an Agent37 address answers 502 with nothing behind it, and 401 for no public port. */
const BRAIN_ANSWER = 404;
const NOTHING_BEHIND = 502;
const NOT_PUBLIC = 401;

function addressUrl(route: Route): string {
  const host = route.host.includes(":") ? `[${route.host}]` : route.host;
  return `https://${host}${route.port === 443 ? "" : `:${route.port}`}/`;
}

/** Resolves true after `ms`, or false at once when `signal` aborts. */
function pause(ms: number, clock: Clock, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = clock.setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    const stop = () => {
      clock.clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Wakes a cloud brain with no door (Agent37) by calling its public address: Agent37 wakes a sleeping instance for any
 * call to it, holding the call while it restores. iOS gives up on a call silent for a minute, so the phone calls again
 * until the brain answers or three minutes pass. 502 goes on for a moment after a boot, then means no brain runs there;
 * `down`, when the phone already found none running, at once.
 */
export async function wakeByAddress(route: Route, call: CallAddress, clock: Clock, signal: AbortSignal, down = false): Promise<WakeOutcome> {
  const url = addressUrl(route);
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal.addEventListener("abort", stop, { once: true });
  const timer = clock.setTimeout(stop, WAKE_WITHIN_MS);
  let last: number | null = null;
  let nothingBehindSince: number | null = null;
  try {
    for (;;) {
      const status = await call(url, abort.signal).catch(() => null);
      if (status === BRAIN_ANSWER) return { kind: "ready", route };
      if (status === NOT_PUBLIC) return { kind: "needs-mac" };
      // Waiting changes no other refusal.
      if (status !== null && status < 500) return { kind: "failed" };
      if (status !== null) last = status;
      if (status === NOTHING_BEHIND) nothingBehindSince ??= clock.now();
      if (nothingBehindSince !== null && (down || clock.now() - nothingBehindSince >= START_WITHIN_MS)) break;
      if (!(await pause(CALL_AGAIN_MS, clock, abort.signal))) break;
    }
  } finally {
    clock.clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
  if (last === NOTHING_BEHIND) return { kind: "needs-mac" };
  return last === null ? { kind: "unanswered" } : { kind: "failed" };
}
