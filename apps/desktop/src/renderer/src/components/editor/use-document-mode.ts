import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { canEditRichly } from "./document-schema";

const MODE_NOTICES = {
  preserved: "This document uses formatting that is preserved in Markdown mode.",
  cannotSwitch: "This document uses formatting that is preserved in Markdown mode. Edit it here to keep all its content.",
} as const;

/** Keeps external Markdown, local rich edits, and source mode in one synchronization path. */
export function useDocumentMode(editor: Editor | null, value: string, onChange: (value: string) => void, initiallyRich: boolean, reportReady: (editor: Editor) => void) {
  const [source, setSource] = useState(!initiallyRich);
  const [sourcePreview, setSourcePreview] = useState(false);
  const [notice, setNotice] = useState(initiallyRich ? "" : MODE_NOTICES.preserved);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const sourceSelection = useRef<{ start: number; end: number } | null>(null);
  const emitted = useRef(value);
  const richSelection = useRef<{ from: number; to: number; value: string } | null>(null);
  const callbacks = useRef({ onChange, reportReady });
  callbacks.current = { onChange, reportReady };

  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    if (!canEditRichly(value)) {
      setSource(true);
      setNotice(MODE_NOTICES.preserved);
      return;
    }
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    callbacks.current.reportReady(editor);
  }, [editor, value]);

  useLayoutEffect(() => {
    if (!source || sourcePreview || !sourceSelection.current || !sourceInput.current) return;
    sourceInput.current.setSelectionRange(sourceSelection.current.start, sourceSelection.current.end);
  }, [source, sourcePreview]);

  const emitRich = (currentEditor: Editor): void => {
    if (source) return;
    const markdown = currentEditor.getMarkdown();
    emitted.current = markdown;
    callbacks.current.onChange(markdown);
  };

  const emitSource = (markdown: string): void => {
    emitted.current = markdown;
    callbacks.current.onChange(markdown);
  };

  const rememberSourceSelection = (): void => {
    const input = sourceInput.current;
    if (input) sourceSelection.current = { start: input.selectionStart, end: input.selectionEnd };
  };

  const toggleSourcePreview = (): void => {
    if (!sourcePreview) rememberSourceSelection();
    setSourcePreview((preview) => !preview);
  };

  const switchMode = (): void => {
    if (!source) {
      if (editor) richSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to, value: emitted.current };
      setSource(true);
      setSourcePreview(false);
      return;
    }
    if (!canEditRichly(value)) {
      setNotice(MODE_NOTICES.cannotSwitch);
      return;
    }
    editor?.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    if (editor && richSelection.current?.value === value) {
      editor.commands.setTextSelection({ from: richSelection.current.from, to: richSelection.current.to });
    }
    setNotice("");
    setSource(false);
  };

  const focus = (): void => {
    if (source) sourceInput.current?.focus();
    else editor?.commands.focus();
  };

  return { source, sourcePreview, notice, sourceInput, emitRich, emitSource, rememberSourceSelection, toggleSourcePreview, switchMode, focus };
}
