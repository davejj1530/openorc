/** The list with one entry taken out and put back ahead of another, or last when that other is not there. */
export function movedBefore<T extends { id: string }>(list: readonly T[], id: string, beforeId: string | null): T[] {
  const moved = list.find((each) => each.id === id);
  if (!moved || id === beforeId) return [...list];
  const rest = list.filter((each) => each !== moved);
  const at = rest.findIndex((each) => each.id === beforeId);
  rest.splice(at < 0 ? rest.length : at, 0, moved);
  return rest;
}
