/**
 * The threads started under a cloud thread, as the server lists them: every row whose family's top (`rootId`) is the
 * thread and that was started under another (relation "started"), each after the one it was started under.
 */
export function startedFamily<Row extends { id: string; parentId: string | null; rootId: string | null; relation: string | null }>(rows: Iterable<Row>, threadId: string): Row[] {
  const started = [...rows].filter((row) => row.rootId === threadId && row.relation === "started");
  const ordered: Row[] = [];
  for (let under = new Set([threadId]); under.size;) {
    const next = started.filter((row) => row.parentId !== null && under.has(row.parentId));
    ordered.push(...next);
    under = new Set(next.map((row) => row.id));
  }
  return ordered;
}
