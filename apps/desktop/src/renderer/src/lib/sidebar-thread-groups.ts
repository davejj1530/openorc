import type { ThreadSummary } from "@openorc/protocol";
import type { SidebarFilter } from "./layout";

/**
 * One project's fetched page, with the active thread kept visible even when it falls outside that page. Hidden
 * threads, such as Orclings' own conversations listed apart, are left out.
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
}) {
  const list = (fetched ?? []).filter((thread) => !hidden?.has(thread.id)).slice(0, limit);
  if (selected && !hidden?.has(selected.id) && selected.projectId === projectId && (filter === "archived") === !!selected.archivedAt && !list.some((thread) => thread.id === selected.id))
    list.push(selected);
  const snoozed = filter === "active" ? list.filter((thread) => thread.snoozedUntil && thread.snoozedUntil > now) : [];
  const pinned = filter === "active" ? list.filter((thread) => thread.pinnedAt && !snoozed.includes(thread)) : [];
  const rest = list.filter((thread) => !pinned.includes(thread) && !snoozed.includes(thread));
  return { list, pinned, rest, snoozed, hasMore: (fetched?.length ?? 0) > limit };
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
