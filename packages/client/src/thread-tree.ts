import { isSubagentThread, THREAD_CHILD_PAGE, type ThreadSummary } from "@openorc/protocol";

/** Started threads own their archive, pin and snooze settings; native children inherit them. */
export function visibleThreadForest(all: readonly ThreadSummary[], archived: boolean, now: number, hidden?: ReadonlySet<string>): ThreadSummary[] {
  const byId = new Map(all.map((thread) => [thread.id, thread]));
  const visibility = new Map<string, boolean>();
  const visible = (thread: ThreadSummary): boolean => {
    const saved = visibility.get(thread.id);
    if (saved !== undefined) return saved;
    visibility.set(thread.id, false);
    const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
    const show = !hidden?.has(thread.id) && (isSubagentThread(thread) ? Boolean(parent && visible(parent)) : archived === Boolean(thread.archivedAt));
    visibility.set(thread.id, show);
    return show;
  };
  const section = (thread: ThreadSummary) => {
    if (thread.snoozedUntil && thread.snoozedUntil > now) return "snoozed";
    return thread.pinnedAt ? "pinned" : "rest";
  };
  return all.filter(visible).map((thread) => {
    const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
    if (!isSubagentThread(thread) && thread.parentThreadId && (!parent || !visible(parent) || (!archived && section(thread) !== section(parent)))) return { ...thread, parentThreadId: null };
    return thread;
  });
}

export type ThreadTreeRow = {
  thread: ThreadSummary;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  last: boolean;
  /** Ancestors whose trunk continues past this row to another sibling. */
  continuing: number[];
  /** Direct children left behind this parent's page, including those not fetched yet. */
  hiddenChildren?: number;
  visibleChildren?: number;
};

export function threadChildren(all: readonly ThreadSummary[]): Map<string, ThreadSummary[]> {
  const children = new Map<string, ThreadSummary[]>();
  for (const thread of all) {
    if (!thread.parentThreadId) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => b.createdAt - a.createdAt || Number(a.id > b.id) - Number(a.id < b.id));
  return children;
}

export function threadTreeOpen(
  thread: ThreadSummary,
  children: ReadonlyMap<string, readonly ThreadSummary[]>,
  saved: readonly string[],
  visited = new Set<string>(),
  forced: ReadonlySet<string> = new Set(),
): boolean {
  if (saved.includes(`thread-open:${thread.id}`)) return true;
  if (saved.includes(`thread-closed:${thread.id}`) || visited.has(thread.id)) return false;
  if (forced.has(thread.id)) return true;
  visited.add(thread.id);
  return (children.get(thread.id) ?? []).some((child) => child.activity !== "idle" || threadTreeOpen(child, children, [], visited));
}

export function toggleThreadTree(saved: readonly string[], id: string, expanded: boolean): string[] {
  return [...saved.filter((key) => key !== `thread-open:${id}` && key !== `thread-closed:${id}`), `${expanded ? "thread-closed" : "thread-open"}:${id}`];
}

export function threadTreeRoot(thread: ThreadSummary, byId: ReadonlyMap<string, ThreadSummary>): ThreadSummary | null {
  let root: ThreadSummary | undefined = thread;
  const visited = new Set<string>();
  while (root?.parentThreadId && !visited.has(root.id)) {
    visited.add(root.id);
    const parent = byId.get(root.parentThreadId);
    if (!parent) return isSubagentThread(root) ? null : root;
    root = parent;
  }
  return root && !root.parentThreadId ? root : null;
}

export function threadAncestors(all: readonly ThreadSummary[], reveal: readonly string[]): Set<string> {
  const byId = new Map(all.map((thread) => [thread.id, thread]));
  const forced = new Set<string>();
  for (const id of reveal) {
    let parent = byId.get(id)?.parentThreadId;
    while (parent && !forced.has(parent)) {
      forced.add(parent);
      parent = byId.get(parent)?.parentThreadId;
    }
  }
  return forced;
}

export function threadTreeRows(
  roots: readonly ThreadSummary[],
  all: readonly ThreadSummary[],
  saved: readonly string[],
  reveal: readonly string[] = [],
  limits: Readonly<Record<string, number>> = {},
): ThreadTreeRow[] {
  const children = threadChildren(all);
  const forced = threadAncestors(all, reveal);
  const attention = all.filter((thread) => thread.activity !== "idle").map((thread) => thread.id);
  const required = new Set([...reveal, ...forced, ...attention, ...threadAncestors(all, attention)]);
  const rows: ThreadTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (thread: ThreadSummary, depth: number, last: boolean, continuing: number[]) => {
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    const expanded = threadTreeOpen(thread, children, saved, new Set(), forced);
    const siblings = children.get(thread.id) ?? [];
    const shown = siblings.filter((child, index) => index < (limits[thread.id] ?? THREAD_CHILD_PAGE) || required.has(child.id));
    const hiddenChildren = (thread.hiddenChildren ?? 0) + siblings.length - shown.length;
    rows.push({ thread, depth, hasChildren: children.has(thread.id) || hiddenChildren > 0, expanded, last, continuing, hiddenChildren, visibleChildren: shown.length });
    if (expanded) shown.forEach((child, index) => visit(child, depth + 1, index === shown.length - 1, depth && !last ? [...continuing, depth] : continuing));
  };
  for (const root of roots) visit(root, 0, true, []);
  return rows;
}

/** A single stroke keeps translucent lines even when deeper branches share the capped lane. */
export function threadBranchPath(row: ThreadTreeRow, { markX, mid, height, step = 20 }: { markX: number; mid: number; height: number; step?: number }): string {
  const depth = Math.min(row.depth, 3);
  const mark = markX + depth * step;
  const spine = mark - step;
  const paths = row.continuing.map((level) => `M${markX + (Math.min(level, 3) - 1) * step} 0V${height}`);
  if (depth) {
    paths.push(`M${spine} 0V${mid - 6}q0 6 6 6h${step - 14}`);
    if (!row.last) paths.push(`M${spine} ${mid - 6}V${height}`);
  }
  if (row.hasChildren && row.expanded && row.visibleChildren !== 0) {
    paths.push(row.depth >= 3 ? `M${mark} ${mid + 8}H${spine + 6}q-6 0 -6 6V${height}` : `M${mark} ${mid + 8}V${height}`);
  }
  return paths.join(" ");
}

/** A paging row continues only ancestor trunks; its own parent's trunk ended at the last visible child. */
export function threadPageBranchPath(row: ThreadTreeRow, { markX, height, step = 20 }: { markX: number; height: number; step?: number }): string {
  const continuing = row.depth && !row.last ? [...row.continuing, row.depth] : row.continuing;
  return [...new Set(continuing.map((level) => markX + (Math.min(level, 3) - 1) * step))].map((x) => `M${x} 0V${height}`).join(" ");
}

export function threadTreeActivity(thread: ThreadSummary, all: readonly ThreadSummary[]): number {
  const children = threadChildren(all);
  const visited = new Set<string>();
  const latest = (row: ThreadSummary): number => {
    if (visited.has(row.id)) return row.lastActivityAt;
    visited.add(row.id);
    return Math.max(row.treeActivityAt ?? row.lastActivityAt, ...(children.get(row.id) ?? []).map(latest));
  };
  return latest(thread);
}

export function threadTreeMatches(thread: ThreadSummary, all: readonly ThreadSummary[], matches: (row: ThreadSummary) => boolean): boolean {
  const children = threadChildren(all);
  const visited = new Set<string>();
  const visit = (row: ThreadSummary): boolean => {
    if (visited.has(row.id)) return false;
    visited.add(row.id);
    return matches(row) || (children.get(row.id) ?? []).some(visit);
  };
  return visit(thread);
}
