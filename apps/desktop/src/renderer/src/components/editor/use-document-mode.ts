import { useEffect, useRef, useState } from "react";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";

/** Keeps the rich document, the Markdown view, and the saved Markdown in step without replacing what the user is editing. */
export function useDocumentMode(editor: Editor | null, value: string, onChange: (value: string) => void) {
  const [source, setSource] = useState(false);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  // The Markdown the rich document holds. Any other value came from outside the editor.
  const shown = useRef(value);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    if (!editor || editor.isDestroyed || source || value === shown.current) return;
    shown.current = value;
    showMarkdown(editor, value);
  }, [editor, value, source]);

  const emitRich = (current: Editor): void => {
    const markdown = current.getMarkdown();
    shown.current = markdown;
    change.current(markdown);
  };

  const emitSource = (markdown: string): void => change.current(markdown);

  const toggleSource = (): void => setSource((open) => !open);

  const focus = (): void => {
    if (source) sourceInput.current?.focus();
    else editor?.commands.focus();
  };

  return { source, sourceInput, emitRich, emitSource, toggleSource, focus };
}

/** Replaces the document only when the Markdown says something else, keeping the caret near where it was. */
function showMarkdown(editor: Editor, markdown: string): void {
  if (!editor.markdown) return;
  const next = editor.markdown.parse(markdown);
  // The same document restated, or with the empty paragraph TrailingNode keeps at its end, is not a change.
  if (editor.markdown.serialize(next).trimEnd() === editor.getMarkdown().trimEnd()) return;
  const { from, to } = editor.state.selection;
  editor
    .chain()
    .setMeta("addToHistory", false)
    .setContent(next, { emitUpdate: false })
    .command(({ tr }) => {
      const end = tr.doc.content.size;
      tr.setSelection(TextSelection.between(tr.doc.resolve(Math.min(from, end)), tr.doc.resolve(Math.min(to, end))));
      return true;
    })
    .run();
}
