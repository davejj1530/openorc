import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { DocumentEditorHandle } from "../components/DocumentEditor";
import { acknowledgeTaskDraft, sameTaskDraft, taskDraftPatch, type createTaskDraftBarrier, type TaskDocumentDraft } from "./task-draft";

export type TaskDraftTransport = {
  mutateAsync(input: { id: string; patch: ReturnType<typeof taskDraftPatch> }): Promise<unknown>;
  edited?(): void;
  clean?(): void;
  isPending: boolean;
  error: Error | null;
};

type Source = {
  actions: ReturnType<typeof createTaskDraftBarrier>;
  taskId: string;
  storageId: string;
  body: RefObject<DocumentEditorHandle | null>;
  unreadableDraft: MutableRefObject<string | null>;
  imagesReady: MutableRefObject<boolean>;
  mounted: MutableRefObject<boolean>;
  current: MutableRefObject<TaskDocumentDraft>;
  saved: MutableRefObject<TaskDocumentDraft>;
  latestIncoming: MutableRefObject<TaskDocumentDraft>;
  previousIncoming: MutableRefObject<TaskDocumentDraft>;
  save: MutableRefObject<TaskDraftTransport["mutateAsync"]>;
  setSaved(draft: TaskDocumentDraft): void;
};

/** Activity retains this source after Overview closes, including an unstored final keystroke. */
export function useTaskDocumentSource(source: Source): void {
  const { actions, taskId, storageId } = source;
  const latest = useRef(source);
  latest.current = source;
  useLayoutEffect(() => {
    const source = latest.current;
    source.mounted.current = true;
    actions.register({
      prepare: async () => {
        if (source.unreadableDraft.current) throw new Error(source.unreadableDraft.current);
        if (source.body.current) {
          if (!(await source.body.current.flush())) throw new Error("A task image has not saved. Retry or remove it in Overview before continuing.");
        } else if (!source.imagesReady.current) {
          throw new Error("A task image has not saved. Open Overview to retry or remove it before continuing.");
        }
      },
      read: () => (sameTaskDraft(source.current.current, source.saved.current) ? null : { ...source.current.current }),
      save: async (snapshot) => {
        await source.save.current({ id: taskId, patch: taskDraftPatch(snapshot) });
      },
      acknowledge: (snapshot) => {
        source.previousIncoming.current = source.latestIncoming.current;
        source.saved.current = snapshot;
        if (source.mounted.current) source.setSaved(snapshot);
        acknowledgeTaskDraft(storageId, snapshot);
      },
    });
    return () => {
      source.mounted.current = false;
    };
  }, [actions, taskId, storageId]);
}

export function useTaskDraftImages() {
  const [imagesReady, setImagesReady] = useState(true);
  const imagesReadyRef = useRef(true);
  const reportImagesReady = useCallback((ready: boolean) => {
    imagesReadyRef.current = ready;
    setImagesReady(ready);
  }, []);
  return { imagesReady, imagesReadyRef, reportImagesReady };
}
