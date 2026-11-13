import { tagsFor } from "@openorc/client";
import type { PlanLimits } from "@openorc/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { hostClient, hostLink, useHostGroup, useSavedMacs } from "../client";

/** One host's read of its plan limits. */
export interface HostRead {
  /** Codex, then each enabled Claude account, as the host shaped them; empty until a first read answers. */
  accounts: readonly PlanLimits[];
  /** `failed` only when no read ever answered; a later failure keeps the last read. */
  state: "loading" | "ready" | "failed";
  /** False while the phone is not connected to it: the accounts are the last read. */
  live: boolean;
  /** When the host read the newest of these reports, for "Last read at"; null before any report has a time. */
  readAt: number | null;
  /** Whose read this is, for the wait before the first one. */
  hostName: string;
  /** Asks again, after a read that failed. */
  retry: () => void;
}

/** The plan limits as Settings shows them. */
export interface Usage extends HostRead {
  /** The time "Resets in" counts from: on a 30 s beat while live, held where it was while not. */
  now: number;
}

const BEAT_MS = 30_000;
const NO_LIMITS: readonly PlanLimits[] = [];

const hasLimits = (host: Pick<HostRead, "accounts">) => host.accounts.some((account) => account.windows.length > 0 || Boolean(account.credits?.length));

/**
 * Whose limits to show of a Mac and its cloud brain, which run on the same accounts: a host that answers now, the Mac
 * before its brain, else the newest last read. A host that answers with no limits yields to a last read that has them.
 */
export function usageSource<T extends Pick<HostRead, "accounts" | "live" | "readAt">>(hosts: readonly [T, ...T[]]): T {
  const read = hosts.filter(hasLimits).sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0));
  return hosts.find((host) => host.live && hasLimits(host)) ?? read[0] ?? hosts.find((host) => host.live) ?? hosts[0];
}

/**
 * Reads `providers.limits` while mounted, so a host starts its CLIs for a phone only while Usage is on screen, and only
 * while connected: a read made while the phone is not would wait for a session and fail. The host answers from a report
 * up to a minute old, and the phone counts its answer fresh as long, as the desktop does. The answer is kept with the
 * host's lists, so Settings opened while not connected, even after a cold start, still shows the last read.
 */
function useHostRead(host: string | null): HostRead {
  const scoped = hostLink(host);
  const link = useSyncExternalStore(scoped.subscribe, scoped.getState);
  const live = link.kind === "connected";
  // On the host's own cache, under `useRpc`'s key: Settings is scoped to the shown host, and this may read its partner.
  const read = useQuery<PlanLimits[]>(
    {
      queryKey: ["providers.limits", {}],
      queryFn: () => scoped.connection.call("providers.limits", {}),
      meta: { tags: tagsFor("providers.limits", {}) },
      enabled: live,
      staleTime: 60_000,
      gcTime: Infinity,
    },
    hostClient(host).queryClient,
  );
  const accounts = read.data ?? NO_LIMITS;
  const times = accounts.flatMap((account) => (account.refreshedAt === null ? [] : [account.refreshedAt]));
  return {
    accounts,
    state: readState(read.data !== undefined, read.isFetching, read.isError),
    live,
    readAt: times.length ? Math.max(...times) : null,
    hostName: link.kind === "unpaired" ? "" : link.mac.name,
    retry: () => void read.refetch(),
  };
}

function readState(answered: boolean, asking: boolean, failed: boolean): HostRead["state"] {
  if (answered) return "ready";
  return failed && !asking ? "failed" : "loading";
}

/** The limits of the shown host's group: a person's plans are the same whichever of a Mac and its brain answers. */
export function useUsage(): Usage {
  const group = useHostGroup();
  const shownIsBrain = useSavedMacs().find((host) => host.id === group.primary)?.kind === "brain";
  const shown = useHostRead(null);
  const partner = useHostRead(group.partner);
  const macFirst: [HostRead, HostRead] = shownIsBrain ? [partner, shown] : [shown, partner];
  const source = usageSource(group.partner ? macFirst : [shown]);
  return { ...source, now: useBeat(source.live) };
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
