import type { ThreadSummary } from "@openorc/protocol";
import type { SidebarFilter } from "./layout";

/** How long orcmode keeps a thread after it last saw work: a rolling day, so late nights and mornings both carry over. */
export const ORC_MODE_WINDOW = 24 * 60 * 60 * 1000;

/** Orcmode's working set: threads that need you or have an agent on them, unread results, pins, and the last day's work. */
export function inOrcMode(thread: ThreadSummary, now: number): boolean {
  return thread.activity !== "idle" || thread.unread || Boolean(thread.pinnedAt) || now - thread.lastActivityAt < ORC_MODE_WINDOW;
}

/** The list a filter reads from the core. Orcmode narrows the active threads, so it reads those. */
export function listedThreads(filter: SidebarFilter): "active" | "archived" {
  return filter === "archived" ? "archived" : "active";
}

type ThreadPage = { list: ThreadSummary[]; pinned: ThreadSummary[]; rest: ThreadSummary[]; snoozed: ThreadSummary[]; hasMore: boolean; leftOut: number };

/** Orcmode keeps the working set and the open thread. Snoozed threads wait, and the rest are counted rather than shown. */
function orcPage(page: ThreadPage, selected: ThreadSummary | null | undefined, now: number): ThreadPage {
  const keep = (thread: ThreadSummary) => thread.id === selected?.id || inOrcMode(thread, now);
  const pinned = page.pinned.filter(keep);
  const rest = page.rest.filter(keep);
  return { ...page, pinned, rest, snoozed: [], leftOut: page.list.length - pinned.length - rest.length };
}

/**
 * One project's fetched page, with the active thread kept visible even when it falls outside that page. Hidden
 * threads, such as Orclings' own conversations listed apart, are left out. In orcmode, `leftOut` counts the loaded
 * threads it does not show.
 */
export function sidebarThreadPage({
  projectId,
  fetched,
  selected,
  filter,
  limit,
  now,
  hidden,
}: {
  projectId: string;
  fetched: readonly ThreadSummary[] | undefined;
  selected: ThreadSummary | null | undefined;
  filter: SidebarFilter;
  limit: number;
  now: number;
  hidden?: ReadonlySet<string>;
}): ThreadPage {
  const archived = filter === "archived";
  const list = (fetched ?? []).filter((thread) => !hidden?.has(thread.id)).slice(0, limit);
  if (selected && !hidden?.has(selected.id) && selected.projectId === projectId && archived === !!selected.archivedAt && !list.some((thread) => thread.id === selected.id)) list.push(selected);
  const snoozed = archived ? [] : list.filter((thread) => thread.snoozedUntil && thread.snoozedUntil > now);
  const pinned = archived ? [] : list.filter((thread) => thread.pinnedAt && !snoozed.includes(thread));
  const rest = list.filter((thread) => !pinned.includes(thread) && !snoozed.includes(thread));
  const page = { list, pinned, rest, snoozed, hasMore: (fetched?.length ?? 0) > limit, leftOut: 0 };
  return filter === "orc" ? orcPage(page, selected, now) : page;
}

/** Match expanded rows, including opt-in snoozed rows. Single-project browsing ignores project folds. */
export function visibleSidebarThreadIds(
  sections: readonly { id: string; pinned: ThreadSummary[]; rest: ThreadSummary[]; snoozed: ThreadSummary[] }[],
  collapsed: readonly string[],
  projectId: string | null = null,
): string[] {
  return sections
    .flatMap((section) =>
      projectId === null && collapsed.includes(`project:${section.id}`)
        ? []
        : [...(collapsed.includes(`pinned:${section.id}`) ? [] : section.pinned), ...section.rest, ...(collapsed.includes(`snoozed-open:${section.id}`) ? section.snoozed : [])],
    )
    .map((thread) => thread.id);
}
