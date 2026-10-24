import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionManager } from "./manager";

/** Something read from the Mac, as a screen shows it. */
export type LinkRead<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed" };

type Done<T> = { key: string; read: LinkRead<T>; session: number | null };

const LOADING = { state: "loading" } as const;

/** Hooks over the phone's link to its Mac. */
export function linkHooks(link: Pick<ConnectionManager, "subscribe" | "getState">) {
  const sessionNow = () => {
    const state = link.getState();
    return state.kind === "connected" ? state.serial : null;
  };

  /** The session the phone has with its Mac, as a number each new session changes, or null while it has none. */
  function useSession(): number | null {
    return useSyncExternalStore(link.subscribe, sessionNow);
  }

  /**
   * What `read` gives for `key`, which names what to read; `read` must keep its identity. It reads once, and after a
   * failure once more on each newer session, so a read the link dropped, or one that found no Mac, goes again once the
   * link is back; it shows as loading again meanwhile, and as failed while the link is down. A read in flight is never
   * sent twice, even when the phone moves to a better route meanwhile.
   */
  function useLinkRead<T>(key: string | null, read: (key: string) => Promise<T>): LinkRead<T> {
    const session = useSession();
    const [done, setDone] = useState<Done<T> | null>(null);
    const mine = key !== null && done?.key === key ? done : null;
    const failedOn = mine?.read.state === "failed" ? mine.session : undefined;
    // The read due now: the first, or the next after the one that failed on `failedOn`.
    let due: string | null = mine ? null : "first";
    if (failedOn !== undefined && session !== null && session !== failedOn) due = `after ${failedOn}`;
    useEffect(() => {
      if (key === null || due === null) return;
      let current = true;
      const on = sessionNow();
      read(key).then(
        (value) => current && setDone({ key, read: { state: "ready", value }, session: on }),
        () => current && setDone({ key, read: { state: "failed" }, session: on }),
      );
      return () => {
        current = false;
      };
    }, [key, due, read]);
    return due === null && mine ? mine.read : LOADING;
  }

  return { useSession, useLinkRead };
}
