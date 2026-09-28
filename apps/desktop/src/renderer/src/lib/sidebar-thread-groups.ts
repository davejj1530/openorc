import type { ThreadSummary } from "@openorc/protocol";
import type { SidebarFilter } from "./layout";

/** One project's fetched page, with the active thread kept visible even when it falls outside that page. */
export function sidebarThreadPage({
  projectId,
  fetched,
  selected,
  filter,
  limit,
  now,
}: {
  projectId: string;
  fetched: readonly ThreadSummary[] | undefined;
  selected: ThreadSummary | null | undefined;
  filter: SidebarFilter;
  limit: number;
  now: number;
}) {
  const list = (fetched ?? []).slice(0, limit);
  if (selected && selected.projectId === projectId && (filter === "archived") === !!selected.archivedAt && !list.some((thread) => thread.id === selected.id)) list.push(selected);
  const snoozed = filter === "active" ? list.filter((thread) => thread.snoozedUntil && thread.snoozedUntil > now) : [];
  const pinned = filter === "active" ? list.filter((thread) => thread.pinnedAt && !snoozed.includes(thread)) : [];
  const rest = list.filter((thread) => !pinned.includes(thread) && !snoozed.includes(thread));
  return { list, pinned, rest, snoozed, hasMore: (fetched?.length ?? 0) > limit };
}

/** Match the rows actually expanded in the sidebar, including the opt-in snoozed section. */
export function visibleSidebarThreadIds(sections: readonly { id: string; pinned: ThreadSummary[]; rest: ThreadSummary[]; snoozed: ThreadSummary[] }[], collapsed: readonly string[]): string[] {
  return sections
    .flatMap((section) =>
      collapsed.includes(`project:${section.id}`)
        ? []
        : [...(collapsed.includes(`pinned:${section.id}`) ? [] : section.pinned), ...section.rest, ...(collapsed.includes(`snoozed-open:${section.id}`) ? section.snoozed : [])],
    )
    .map((thread) => thread.id);
}
