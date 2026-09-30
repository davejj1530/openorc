export interface TaskDocumentDraft {
  title: string;
  spec: string;
  labels: string;
}

const storageKey = (taskId: string) => `openorc.draft.task.${taskId}`;

export function sameTaskDraft(a: TaskDocumentDraft, b: TaskDocumentDraft): boolean {
  return a.title === b.title && a.spec === b.spec && a.labels === b.labels;
}

/** Read strictly: a missing draft is different from one we cannot safely save. */
export function readTaskDraft(taskId: string): TaskDocumentDraft | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(taskId));
  } catch {
    throw new Error("Could not read the local task draft. Open Overview and save it before continuing.");
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "title" in value &&
      typeof value.title === "string" &&
      "spec" in value &&
      typeof value.spec === "string" &&
      "labels" in value &&
      typeof value.labels === "string"
    ) {
      return { title: value.title, spec: value.spec, labels: value.labels };
    }
  } catch {
    /* Preserve the original draft for recovery. */
  }
  throw new Error("The local task draft could not be read. Open Overview and save the task before continuing.");
}

function labelList(labels: string): string[] {
  return [
    ...new Set(
      labels
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function taskDraftPatch(draft: TaskDocumentDraft) {
  if (!draft.title.trim()) throw new Error("Add a task title in Overview before continuing.");
  if (draft.spec.includes("openorc-pending://")) throw new Error("A task image has not saved. Open Overview to retry or remove it before continuing.");
  return { title: draft.title.trim(), spec: draft.spec.trim() || null, labels: labelList(draft.labels) };
}

/** Drafts that save the same task fields. The server returns a saved draft trimmed, so its copy is not a new revision. */
export function sameSavedTaskDraft(a: TaskDocumentDraft, b: TaskDocumentDraft): boolean {
  return a.title.trim() === b.title.trim() && a.spec.trim() === b.spec.trim() && labelList(a.labels).join(",") === labelList(b.labels).join(",");
}

/** Another window or a later keystroke may have replaced this exact snapshot. */
export function acknowledgeTaskDraft(taskId: string, saved: TaskDocumentDraft): void {
  try {
    const current = readTaskDraft(taskId);
    if (current && sameTaskDraft(current, saved)) localStorage.removeItem(storageKey(taskId));
  } catch {
    /* A confirmed server save must not discard an unreadable local draft. */
  }
}

export interface TaskDraftSource {
  prepare(): Promise<void>;
  read(): TaskDocumentDraft | null;
  save(draft: TaskDocumentDraft): Promise<void>;
  acknowledge(draft: TaskDocumentDraft): void;
}

/** Re-read after images and every save so an action includes the final keystroke. */
export async function flushTaskDraftSource(source: TaskDraftSource): Promise<void> {
  for (;;) {
    await source.prepare();
    const snapshot = source.read();
    if (!snapshot) return;
    taskDraftPatch(snapshot);
    await source.save(snapshot);
    source.acknowledge(snapshot);
  }
}

/** One barrier per task view, shared by autosave, navigation, and task actions. */
export function createTaskDraftBarrier(taskId: string, save: (draft: TaskDocumentDraft) => Promise<void>) {
  let source: TaskDraftSource | null = null;
  let pending: Promise<void> | null = null;
  let acknowledged: TaskDocumentDraft | null = null;
  const stored: TaskDraftSource = {
    prepare: async () => {},
    read: () => {
      const draft = readTaskDraft(taskId);
      return draft && (!acknowledged || !sameTaskDraft(draft, acknowledged)) ? draft : null;
    },
    save,
    acknowledge: (draft) => {
      acknowledged = draft;
      acknowledgeTaskDraft(taskId, draft);
    },
  };
  return {
    register(next: TaskDraftSource) {
      source = next;
    },
    flushTaskDraft(id: string): Promise<void> {
      if (id !== taskId) return Promise.reject(new Error("The task changed. Open its Overview and try again."));
      if (pending) return pending;
      const work = (async () => {
        let selected: TaskDraftSource | null;
        do {
          selected = source;
          await flushTaskDraftSource(selected ?? stored);
          // A tab change can mount a new editor while an older save settles.
        } while (selected !== source);
      })();
      pending = work.finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
