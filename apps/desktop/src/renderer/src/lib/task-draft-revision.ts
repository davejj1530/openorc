import type { OnlineTask } from "@openorc/protocol";
import { readTaskDraft, sameSavedTaskDraft } from "./task-draft";

const key = (storageId: string) => `openorc.draft.task-revision.${storageId}`;
/** Missing revision data requires a choice when recovered words differ from the current document. */
export function recoveredTaskRevision(storageId: string, task: OnlineTask): number | null | undefined {
  try {
    const draft = readTaskDraft(storageId);
    if (!draft || sameSavedTaskDraft(draft, { title: task.title, spec: task.spec ?? "", labels: task.labels.join(", ") })) return undefined;
    const raw = localStorage.getItem(key(storageId));
    const revision = raw === null ? NaN : Number(raw);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  } catch {
    return null;
  }
}
export function keepTaskDraftRevision(storageId: string, revision: number | null): void {
  try {
    if (revision === null) localStorage.removeItem(key(storageId));
    else localStorage.setItem(key(storageId), String(revision));
  } catch {
    /* A recovered draft without revision data always requires an explicit choice. */
  }
}
