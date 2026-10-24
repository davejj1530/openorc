import { useEffect } from "react";
import { useRowState } from "./row-state";
import { replyKey, type Row } from "./rows";

/**
 * The rows that arrive live in this pass, adding every row to `known`: a row new since the last pass that comes after
 * every row already known, so an older page landing above never arrives. The agent's presence stays at the end, below
 * what arrives, so it does not count. A reply's next piece is its words carrying on, so it arrives only with the
 * reply's first; a finished turn's actions come in still, as on the desktop.
 */
export function newArrivals(rows: Row[], known: Set<string>): string[] {
  const lastKnown = rows.findLastIndex((row) => row.kind !== "presence" && known.has(row.key));
  const arrived = rows.flatMap((row, index) => {
    if (index <= lastKnown || known.has(row.key) || row.kind === "actions") return [];
    if (row.kind === "reply" && row.source.index > 0 && known.has(replyKey(row.source.blockId, 0))) return [];
    return [row.key];
  });
  for (const row of rows) known.add(row.key);
  return arrived;
}

/**
 * Whether this row plays its arrival: decided when a row first shows here, and the arrival is used up then. A row
 * seen again later, recycled into another view or remounted after the reader scrolled away, is simply there.
 */
export function useArrival(key: string, arrivals: Set<string>): boolean {
  const [play] = useRowState(key, () => arrivals.has(key));
  useEffect(() => {
    if (play) arrivals.delete(key);
  }, [play, key, arrivals]);
  return play;
}
