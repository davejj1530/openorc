import type { ThreadListFilter } from "./repos.js";

/** Only fixed SQL fragments leave this decision; filter values never become SQL. */
export function threadListOrder(kind: ThreadListFilter, orderBy?: "activity"): string {
  if (orderBy === "activity") return "last_activity_at DESC, id DESC";
  if (kind === "archived") return "archived_at DESC";
  if (kind === "done") return "done_at DESC";
  return "(pinned_at IS NOT NULL) DESC, last_activity_at DESC";
}
