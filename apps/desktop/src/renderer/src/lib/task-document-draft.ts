import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@openorc/protocol";
import type { DocumentEditorHandle } from "../components/DocumentEditor";
import { writeDraft } from "./drafts";
import { acknowledgeTaskDraft, readTaskDraft, sameSavedTaskDraft, sameTaskDraft, taskDraftPatch, type TaskDocumentDraft } from "./task-draft";
import { useTaskDraftActions } from "./task-draft-context";
import { useRpcMutation } from "./query";

/** The locally kept draft when there is one. An unreadable draft is reported, never replaced. */
function initialDraft(taskId: string, incoming: TaskDocumentDraft): { draft: TaskDocumentDraft; error: string | null } {
  try {
    return { draft: readTaskDraft(taskId) ?? incoming, error: null };
  } catch (error) {
    return { draft: incoming, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One mounted Overview owns its editor; the task barrier retains its draft after navigation. */
export function useTaskDocumentDraft(task: Pick<Task, "id" | "title" | "spec" | "labels">) {
  const actions = useTaskDraftActions();
  const body = useRef<DocumentEditorHandle>(null);
  const mounted = useRef(false);
  const [imagesReady, setImagesReady] = useState(true);
  const imagesReadyRef = useRef(true);
  const [draftStored, setDraftStored] = useState(true);
  const labels = task.labels.join(", ");
  const incoming = useMemo(() => ({ title: task.title, spec: task.spec ?? "", labels }), [task.title, task.spec, labels]);
  const previousIncoming = useRef(incoming);
  const latestIncoming = useRef(incoming);
  latestIncoming.current = incoming;
  const [initial] = useState(() => initialDraft(task.id, incoming));
  const [draft, setDraft] = useState(initial.draft);
  const [error, reportError] = useState<string | null>(initial.error);
  const unreadableDraft = useRef(initial.error);
  const [saved, setSaved] = useState(incoming);
  const savedRef = useRef(saved);
  const current = useRef(draft);
  const save = useRpcMutation("tasks.update");
  const saveRef = useRef(save.mutateAsync);
  saveRef.current = save.mutateAsync;
  const dirty = !sameTaskDraft(draft, saved);

  const patch = (value: Partial<TaskDocumentDraft>) => {
    const next = { ...current.current, ...value };
    current.current = next;
    setDraft(next);
    const stored = writeDraft(`task.${task.id}`, next);
    setDraftStored(stored);
    if (stored) unreadableDraft.current = null;
    reportError(null);
  };

  useLayoutEffect(() => {
    mounted.current = true;
    actions.register({
      prepare: async () => {
        if (unreadableDraft.current) throw new Error(unreadableDraft.current);
        if (body.current) {
          if (!(await body.current.flush())) throw new Error("A task image has not saved. Retry or remove it in Overview before continuing.");
        } else if (!imagesReadyRef.current) {
          throw new Error("A task image has not saved. Open Overview to retry or remove it before continuing.");
        }
      },
      read: () => (sameTaskDraft(current.current, savedRef.current) ? null : { ...current.current }),
      save: async (snapshot) => {
        await saveRef.current({ id: task.id, patch: taskDraftPatch(snapshot) });
      },
      acknowledge: (snapshot) => {
        // This completed write supersedes server values observed before it settled.
        previousIncoming.current = latestIncoming.current;
        savedRef.current = snapshot;
        if (mounted.current) setSaved(snapshot);
        acknowledgeTaskDraft(task.id, snapshot);
      },
    });
    return () => {
      mounted.current = false;
      // Keep this source registered: Activity can still save an Overview draft
      // that local storage could not retain. A remount replaces it in the barrier.
    };
  }, [actions, task.id]);

  const flush = useCallback(async (): Promise<boolean> => {
    try {
      await actions.flushTaskDraft(task.id);
      if (mounted.current) reportError(null);
      return true;
    } catch (failure) {
      if (mounted.current) reportError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
  }, [actions, task.id]);

  useEffect(() => {
    if (!dirty || !imagesReady || save.isPending || save.error) return;
    const timer = setTimeout(() => void flush(), 800);
    return () => clearTimeout(timer);
  }, [draft, dirty, imagesReady, save.isPending, save.error, flush]);

  useEffect(() => {
    // Retain an external revision until the draft is pristine and idle. A local
    // save acknowledges older observed revisions above so they cannot undo it.
    if (previousIncoming.current === incoming) return;
    if (dirty || save.isPending) return;
    previousIncoming.current = incoming;
    // Replacing the draft with the server's copy of it would move the caret mid-sentence.
    if (sameSavedTaskDraft(incoming, current.current)) return;
    acknowledgeTaskDraft(task.id, current.current);
    current.current = incoming;
    savedRef.current = incoming;
    setDraft(incoming);
    setSaved(incoming);
  }, [incoming, dirty, save.isPending, task.id]);

  const reportImagesReady = useCallback((ready: boolean) => {
    imagesReadyRef.current = ready;
    setImagesReady(ready);
  }, []);

  return { draft, patch, body, imagesReady, reportImagesReady, draftStored, dirty, saving: save.isPending, saveError: save.error, error, reportError, flush };
}
