import type { PlanLimits } from "@openorc/protocol";
import { useEffect, useState } from "react";
import { useLinkState, useRpc } from "../client";

/** The Mac's plan limits as Settings shows them. */
export interface Usage {
  /** Codex, then each enabled Claude account, as the Mac shaped them; empty until a first read answers. */
  accounts: readonly PlanLimits[];
  /** `failed` only when no read ever answered; a later failure keeps the last read. */
  state: "loading" | "ready" | "failed";
  /** False while the phone is not connected: the accounts are the last read, and `now` holds still. */
  live: boolean;
  /** When the Mac read the newest of these reports, for "Last read at"; null before any report has a time. */
  readAt: number | null;
  /** The time "Resets in" counts from: on a 30 s beat while live, held where it was while not. */
  now: number;
}

const BEAT_MS = 30_000;

/**
 * Reads `providers.limits` while mounted, so a Mac starts its CLIs for a phone only while Usage is on screen, and only
 * while connected: a read made while the phone is not would wait for a session and fail. The Mac answers from a report
 * up to a minute old, and the phone counts its answer fresh as long, as the desktop does. The answer stays for as long
 * as the app shows this Mac, so Settings opened later while not connected still shows the last read.
 */
export function useUsage(): Usage {
  const live = useLinkState().kind === "connected";
  const read = useRpc("providers.limits", {}, { enabled: live, staleTime: 60_000, gcTime: Infinity });
  const now = useBeat(live);
  const accounts = read.data ?? [];
  const times = accounts.flatMap((account) => (account.refreshedAt === null ? [] : [account.refreshedAt]));
  return {
    accounts,
    state: readState(read.data !== undefined, read.isError),
    live,
    readAt: times.length ? Math.max(...times) : null,
    now,
  };
}

function readState(answered: boolean, failed: boolean): Usage["state"] {
  if (answered) return "ready";
  return failed ? "failed" : "loading";
}

/** The time, again every 30 s while `running`; while not, the time it stopped at. */
function useBeat(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), BEAT_MS);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
