import { tagsFor } from "@openorc/client";
import type { PlanLimits } from "@openorc/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { link, queryClient, useLinkState } from "../client";

/** The plan limits as Settings shows them. */
export interface Usage {
  /** Codex, then each enabled Claude account, as the Mac shaped them; empty until a first read answers. */
  accounts: readonly PlanLimits[];
  /** `failed` only when no read ever answered; a later failure keeps the last read. */
  state: "loading" | "ready" | "failed";
  /** False while the phone is not connected to it: the accounts are the last read. */
  live: boolean;
  /** When the Mac read the newest of these reports, for "Last read at"; null before any report has a time. */
  readAt: number | null;
  /** Whose read this is, for the wait before the first one. */
  hostName: string;
  /** Asks again, after a read that failed. */
  retry: () => void;
  /** The time "Resets in" counts from: on a 30 s beat while live, held where it was while not. */
  now: number;
}

const BEAT_MS = 30_000;
const NO_LIMITS: readonly PlanLimits[] = [];

/**
 * The shown Mac's plan limits. Reads `providers.limits` while mounted, so the Mac starts its CLIs for a phone only while
 * Usage is on screen, and only while connected: a read made while the phone is not would wait for a session and fail.
 * The Mac answers from a report up to a minute old, and the phone counts its answer fresh as long, as the desktop does.
 * The answer is kept with the Mac's lists, so Settings opened while not connected, even after a cold start, still shows
 * the last read.
 */
export function useUsage(): Usage {
  const state = useLinkState();
  const live = state.kind === "connected";
  // Under `useRpc`'s key, and asked as a person's own read each time.
  const read = useQuery<PlanLimits[]>(
    {
      queryKey: ["providers.limits", {}],
      queryFn: () => link.connection.call("providers.limits", {}),
      meta: { tags: tagsFor("providers.limits", {}) },
      enabled: live,
      staleTime: 60_000,
      gcTime: Infinity,
    },
    queryClient,
  );
  const accounts = read.data ?? NO_LIMITS;
  const times = accounts.flatMap((account) => (account.refreshedAt === null ? [] : [account.refreshedAt]));
  return {
    accounts,
    state: readState(read.data !== undefined, read.isFetching, read.isError),
    live,
    readAt: times.length ? Math.max(...times) : null,
    hostName: state.kind === "unpaired" ? "" : state.mac.name,
    retry: () => void read.refetch(),
    now: useBeat(live),
  };
}

function readState(answered: boolean, asking: boolean, failed: boolean): Usage["state"] {
  if (answered) return "ready";
  return failed && !asking ? "failed" : "loading";
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
