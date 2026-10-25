import type { Commit, FileChangeStat, PushState, WorkspaceChanges } from "@openorc/protocol";

/** A row of the Changes screen's list, each kind at its own fixed height. */
export type ChangesItem =
  | { kind: "file"; key: string; file: FileChangeStat }
  | { kind: "unlisted"; key: string; text: string }
  | { kind: "commits"; key: string; text: string }
  | { kind: "commit"; key: string; commit: Commit; unpushed: boolean };

export const ITEM_HEIGHTS: Record<ChangesItem["kind"], number> = { file: 44, unlisted: 44, commits: 44, commit: 60 };

/** The files as the Mac listed them, a row for those past its cap, then the branch's newest commits. */
export function changesItems(changes: WorkspaceChanges | undefined, log: Commit[] | undefined, push: PushState | undefined): ChangesItem[] {
  const items: ChangesItem[] = (changes?.files ?? []).map((file) => ({ kind: "file", key: `file:${file.path}`, file }));
  if (changes?.unlisted) items.push({ kind: "unlisted", key: "unlisted", text: `${changes.unlisted.toLocaleString("en-US")} more ${changes.unlisted === 1 ? "file" : "files"}` });
  if (!log?.length) return items;
  const unpushed = new Set(push?.unpushed);
  items.push({ kind: "commits", key: "commits", text: push?.branch ? `Commits · ${push.branch}` : "Commits" });
  for (const commit of log) items.push({ kind: "commit", key: `commit:${commit.sha}`, commit, unpushed: unpushed.has(commit.sha) });
  return items;
}
