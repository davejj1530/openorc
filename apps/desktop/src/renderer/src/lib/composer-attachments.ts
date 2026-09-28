import { useCallback, useId, useSyncExternalStore } from "react";
import { readDraft, writeDraft } from "./drafts";
import { importImage } from "./image-imports";
import { importFile, isImageAttachment } from "./file-imports";

export interface Attachment {
  path: string;
  /** Only images have a served thumbnail URL. */
  url: string | null;
  name: string;
  /** Shown on a non-image chip, which has no picture to state its weight. */
  bytes?: number;
}

type AttachmentState = { attachments: Attachment[]; uploading: number; error: string | null };
const drafts = new Map<string, AttachmentState>();
const listeners = new Map<string, Set<() => void>>();

function currentState(key: string, draftKey?: string): AttachmentState {
  let state = drafts.get(key);
  if (!state) {
    const attachments = draftKey ? readDraft(draftKey, { attachments: [] as Attachment[] }).attachments : [];
    state = { attachments, uploading: 0, error: null };
    drafts.set(key, state);
  }
  return state;
}

function releaseSettledDraft(key: string, draftKey?: string): void {
  const state = drafts.get(key);
  if (listeners.has(key) || !state || state.uploading > 0) return;
  // Saved attachments are durable. Keep only errors that a returning draft must show.
  if (!draftKey || !state.error) drafts.delete(key);
}

function updateState(key: string, draftKey: string | undefined, update: (state: AttachmentState) => AttachmentState): void {
  const previous = currentState(key, draftKey);
  const state = update(previous);
  if (draftKey && state.attachments !== previous.attachments) {
    const saved = readDraft(draftKey, { attachments: [] as Attachment[] });
    writeDraft(draftKey, { ...saved, attachments: state.attachments });
  }
  drafts.set(key, state);
  for (const listener of listeners.get(key) ?? []) listener();
  releaseSettledDraft(key, draftKey);
}

/** Files, pending imports and failures belong to the draft across navigation. */
export function useComposerAttachments({ draftKey, disabledReason }: { draftKey?: string; disabledReason?: string | null }) {
  const instanceId = useId();
  const key = draftKey ? `draft:${draftKey}` : `instance:${instanceId}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
        releaseSettledDraft(key, draftKey);
      };
    },
    [key, draftKey],
  );
  const snapshot = useCallback(() => currentState(key, draftKey), [key, draftKey]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const update = useCallback((change: (state: AttachmentState) => AttachmentState) => updateState(key, draftKey, change), [key, draftKey]);
  const remove = useCallback(
    (paths: string[]) => {
      update((state) => ({ ...state, attachments: state.attachments.filter((attachment) => !paths.includes(attachment.path)) }));
    },
    [update],
  );
  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabledReason) {
        update((state) => ({ ...state, error: disabledReason }));
        return;
      }
      if (!files.length) return;
      update((state) => ({ ...state, uploading: state.uploading + files.length }));
      for (const file of files) {
        const image = isImageAttachment(file);
        const label = file.name || (image ? "Pasted image" : "Attached file");
        try {
          const saved = image ? await importImage(file, label) : await importFile(file, label);
          const attachment = { path: saved.path, url: "url" in saved ? saved.url : null, name: label, bytes: file.size };
          update((state) => ({ ...state, attachments: [...state.attachments, attachment] }));
        } catch (error) {
          update((state) => ({ ...state, error: `Couldn’t attach ${label}. ${error instanceof Error ? error.message : "Try again."}` }));
        } finally {
          update((state) => ({ ...state, uploading: state.uploading - 1 }));
        }
      }
    },
    [disabledReason, update],
  );

  return { ...state, addFiles, remove, clearError: () => update((state) => ({ ...state, error: null })) };
}

/** Acceptance can arrive after the view unmounts; keep files added after submission. */
export function removeAcceptedAttachments(draftKey: string | undefined, paths: string[]): void {
  if (!draftKey) return;
  updateState(`draft:${draftKey}`, draftKey, (state) => ({ ...state, attachments: state.attachments.filter((attachment) => !paths.includes(attachment.path)) }));
}
