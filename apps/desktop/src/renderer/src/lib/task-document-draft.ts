import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@openorc/protocol";
import type { DocumentEditorHandle } from "../components/DocumentEditor";
import { writeDraft } from "./drafts";
import { acknowledgeTaskDraft, readTaskDraft, sameSavedTaskDraft, sameTaskDraft, type TaskDocumentDraft } from "./task-draft";
import { useTaskDraftActions } from "./task-draft-context";
import { useRpcMutation } from "./client";
import { useTaskDocumentSource, type TaskDraftTransport } from "./task-document-source";

/** The locally kept draft when there is one. An unreadable draft is reported, never replaced. */
function initialDraft(taskId: string, incoming: TaskDocumentDraft): { draft: TaskDocumentDraft; error: string | null } {
  try {
    return { draft: readTaskDraft(taskId) ?? incoming, error: null };
  } catch (error) {
    return { draft: incoming, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One mounted Overview owns its editor; the task barrier retains its draft after navigation. */
export function useTaskDocumentDraft(task: Pick<Task, "id" | "title" | "spec" | "labels">, online?: { storageId: string; save: TaskDraftTransport }) {
  const storageId = online?.storageId ?? task.id;
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
  const [initial] = useState(() => initialDraft(storageId, incoming));
  const [draft, setDraft] = useState(initial.draft);
  const [error, reportError] = useState<string | null>(initial.error);
  const unreadableDraft = useRef(initial.error);
  const [saved, setSaved] = useState(incoming);
  const savedRef = useRef(saved);
  const current = useRef(draft);
  const localSave = useRpcMutation("tasks.update");
  const save = online?.save ?? localSave;
  const saveRef = useRef(save.mutateAsync);
  saveRef.current = save.mutateAsync;
  const dirty = !sameTaskDraft(draft, saved);

  const patch = (value: Partial<TaskDocumentDraft>) => {
    const next = { ...current.current, ...value };
    current.current = next;
    setDraft(next);
    const stored = writeDraft(`task.${storageId}`, next);
    setDraftStored(stored);
    if (stored) unreadableDraft.current = null;
    reportError(null);
  };

  useTaskDocumentSource({
    actions,
    taskId: task.id,
    storageId,
    body,
    unreadableDraft,
    imagesReady: imagesReadyRef,
    mounted,
    current,
    saved: savedRef,
    latestIncoming,
    previousIncoming,
    save: saveRef,
    setSaved,
  });

  const flush = useCallback(async (): Promise<boolean> => {
    try {
      await actions.flushTaskDraft(storageId);
      if (mounted.current) reportError(null);
      return true;
    } catch (failure) {
      if (mounted.current) reportError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
  }, [actions, storageId]);

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
    acknowledgeTaskDraft(storageId, current.current);
    current.current = incoming;
    savedRef.current = incoming;
    setDraft(incoming);
    setSaved(incoming);
  }, [incoming, dirty, save.isPending, storageId]);

  const reportImagesReady = useCallback((ready: boolean) => {
    imagesReadyRef.current = ready;
    setImagesReady(ready);
  }, []);

  const replaceSaved = (next: TaskDocumentDraft) => {
    acknowledgeTaskDraft(storageId, current.current);
    current.current = next;
    savedRef.current = next;
    previousIncoming.current = latestIncoming.current;
    setDraft(next);
    setSaved(next);
    reportError(null);
  };

  return { draft, patch, replaceSaved, body, imagesReady, reportImagesReady, draftStored, dirty, saving: save.isPending, saveError: save.error, error, reportError, flush };
}
