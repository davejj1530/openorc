import { useCallback, useEffect, useRef, useState } from "react";

type Loaded<T> = { key: string; data: T | undefined; error: Error | null; loading: boolean };

/**
 * One read named by `key`, read again on `refetch`; null reads nothing. A later read wins over an earlier one, and a
 * failed read again keeps what was read before beside its error. A composer of this Mac never makes one, so it needs
 * no query client.
 */
export function useLoaded<T>(key: string | null, load: () => Promise<T>) {
  const [state, setState] = useState<Loaded<T> | null>(null);
  const turn = useRef(0);
  const latest = useRef(load);
  latest.current = load;
  const refetch = useCallback(() => {
    if (key === null) return;
    const mine = ++turn.current;
    latest.current().then(
      (data) => {
        if (mine === turn.current) setState({ key, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (mine === turn.current)
          setState((before) => ({ key, data: before?.key === key ? before.data : undefined, error: error instanceof Error ? error : new Error(String(error)), loading: false }));
      },
    );
  }, [key]);
  useEffect(() => {
    turn.current++;
    refetch();
  }, [refetch]);
  const current = state?.key === key ? state : null;
  return { data: current?.data, error: current?.error ?? null, loading: key !== null && (current?.loading ?? true), refetch };
}
