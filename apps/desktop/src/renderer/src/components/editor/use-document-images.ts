import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { finishImageImport, stageImage } from "../../lib/image-imports";
import { hasPendingImages } from "./document-schema";

const IMAGE_ERRORS = {
  stage: "Couldn’t import this image.",
  sourcePending: "An image hasn’t saved. Switch to rich text to retry it, or remove its Markdown reference.",
  save: "An image hasn’t saved. Retry or remove it.",
} as const;

function pendingImages(editor: Editor): string[] {
  const pending: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image" && String(node.attrs.src).startsWith("openorc-pending://")) pending.push(String(node.attrs.src));
  });
  return [...new Set(pending)];
}

/** Owns staged bytes, selection tracking, readiness, and cleanup for one editor mount. */
export function useDocumentImages(onReadyChange: ((ready: boolean) => void) | undefined, onError: (message: string) => void) {
  const callbacks = useRef({ onReadyChange, onError });
  callbacks.current = { onReadyChange, onError };
  const staging = useRef(new Set<Promise<void>>());
  const listeners = useRef(new Set<() => void>());
  const ready = useRef(true);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const ownedListeners = listeners.current;
    return () => {
      mounted.current = false;
      for (const detach of ownedListeners) detach();
      ownedListeners.clear();
    };
  }, []);

  const reportReady = (editor: Editor): void => {
    if (!mounted.current || editor.isDestroyed) return;
    const next = staging.current.size === 0 && pendingImages(editor).length === 0;
    if (next !== ready.current) {
      ready.current = next;
      callbacks.current.onReadyChange?.(next);
    }
    setBusy(!next);
  };

  const stage = (editor: Editor, files: File[], position?: number): void => {
    if (editor.isDestroyed || !mounted.current) return;
    if (position !== undefined) editor.commands.setTextSelection(position);
    let bookmark = editor.state.selection.getBookmark();
    const map = ({ transaction }: { transaction: Transaction }) => {
      bookmark = bookmark.map(transaction.mapping);
    };
    editor.on("transaction", map);
    const detach = () => {
      editor.off("transaction", map);
      listeners.current.delete(detach);
    };
    listeners.current.add(detach);

    const work = (async () => {
      const images = [];
      for (const file of files) {
        try {
          images.push({ type: "image", attrs: { src: `openorc-pending://${await stageImage(file)}`, alt: file.name || "Pasted image" } });
        } catch (reason) {
          if (mounted.current) callbacks.current.onError(reason instanceof Error ? reason.message : IMAGE_ERRORS.stage);
        }
      }
      if (!mounted.current || editor.isDestroyed || !images.length) return;
      const selection = bookmark.resolve(editor.state.doc);
      editor
        .chain()
        .insertContentAt({ from: selection.from, to: selection.to }, [...images, { type: "paragraph" }], { updateSelection: true })
        .focus()
        .run();
    })().finally(() => {
      detach();
      staging.current.delete(work);
      reportReady(editor);
    });
    staging.current.add(work);
    reportReady(editor);
  };

  const flush = async (editor: Editor | null, source: boolean, value: string): Promise<boolean> => {
    if (!editor) return true;
    if (source) {
      if (hasPendingImages(value)) {
        callbacks.current.onError(IMAGE_ERRORS.sourcePending);
        return false;
      }
      return true;
    }
    try {
      await Promise.all(staging.current);
      if (!mounted.current || editor.isDestroyed) return false;
      for (const src of pendingImages(editor)) {
        const saved = await finishImageImport(src.slice("openorc-pending://".length));
        if (!mounted.current || editor.isDestroyed) return false;
        const transaction = editor.state.tr;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs.src === src) transaction.setNodeMarkup(pos, undefined, { ...node.attrs, src: saved.url });
        });
        editor.view.dispatch(transaction.setMeta("addToHistory", false));
      }
      reportReady(editor);
      return ready.current;
    } catch (reason) {
      if (mounted.current) callbacks.current.onError(reason instanceof Error ? reason.message : IMAGE_ERRORS.save);
      return false;
    }
  };

  return { busy, reportReady, stage, flush };
}
