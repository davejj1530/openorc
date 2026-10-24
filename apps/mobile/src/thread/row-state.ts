import { useCallback, useState } from "react";

/**
 * State that belongs to one row of a list that hands its views from row to row: a view given another row starts again
 * from `initial`, and an update meant for the row it showed before (a timer, a promise) never reaches the new one.
 */
export function useRowState<T>(key: string, initial: () => T): [T, (value: T) => void] {
  const [held, setHeld] = useState(() => ({ key, value: initial() }));
  let current = held;
  if (held.key !== key) {
    current = { key, value: initial() };
    setHeld(current);
  }
  const set = useCallback((value: T) => setHeld((now) => (now.key === key ? { key, value } : now)), [key]);
  return [current.value, set];
}
