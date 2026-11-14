import { useEffect, useRef } from "react";
import type { TeamChatRow } from "@openorc/client";
import { useListHold } from "./use-list-hold";

const key = (row: TeamChatRow) => `${row.kind}:${row.id}`;
function group(row: TeamChatRow) {
  if (row.kind === "person") return 0;
  return row.conversation.kind === "dm" ? 1 : 2;
}

function heldRows(rows: readonly TeamChatRow[], before: readonly string[]): readonly TeamChatRow[] {
  const positions = new Map(before.map((id, index) => [id, index]));
  const position = (row: TeamChatRow) => positions.get(key(row)) ?? before.length;
  return [...rows].sort((a, b) => group(a) - group(b) || position(a) - position(b));
}

/** Retain only order, so access changes and current identities are never held back. */
export function useTeamChatOrder(rows: readonly TeamChatRow[]) {
  const hold = useListHold();
  const remembered = useRef<readonly string[]>([]);
  const shown = hold.held ? heldRows(rows, remembered.current) : rows;
  useEffect(() => {
    remembered.current = shown.map(key);
  }, [shown]);
  return { rows: shown, props: hold.props };
}
