import { $getRoot, mergeRegister, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG } from "lexical";
import { useEffect, useLayoutEffect, useRef } from "react";
import { $readDraft, $writeDraft } from "../draft";
import { EXTERNAL, hasFocus, useLatest } from "../shared";
import { useEditor, useRestartHistory } from "../editor";

/**
 * The message and the caret after an update: null while the person is not in the draft, since a caret they never
 * placed must not open a list. `edited` when the person changed the words, by typing or by picking.
 */
export interface DraftChange {
  text: string;
  caret: number | null;
  edited: boolean;
}

/**
 * Keeps the draft and its owner's message in step. A message that changes from outside (a send clearing it, a saved
 * draft coming back) is written in with the caret at its end and starts a fresh undo history, as a text field's does;
 * every update reports the message and the caret back.
 */
export function DraftPlugin({ value, onChange }: { value: string; onChange: (change: DraftChange) => void }) {
  const editor = useEditor();
  const report = useLatest(onChange);
  const restartHistory = useRestartHistory();
  // The message as the draft last said it. Only a value other than that comes from outside: one that merely trails the
  // draft, as fast typing outruns the owner's render, must not be written back over newer words.
  const said = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (value === said.current) return;
    said.current = value;
    let wrote = false;
    editor.update(
      () => {
        if ($readDraft().text === value) return;
        wrote = true;
        $writeDraft(value);
      },
      { discrete: true, tag: hasFocus(editor) ? EXTERNAL : [EXTERNAL, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG] },
    );
    if (wrote) restartHistory();
  }, [editor, value, restartHistory]);
  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
          const { text, caret } = editorState.read($readDraft);
          said.current = text;
          const before = prevEditorState.read(() => $getRoot().getTextContent());
          report.current({ text, caret: hasFocus(editor) ? caret : null, edited: text !== before && !tags.has(EXTERNAL) });
        }),
        // The page's selection settling where the draft's caret already was, which no update reports, as a text
        // field's select event does: a click that focuses the draft at its kept caret.
        editor.registerRootListener((root) => {
          if (!root) return;
          const settled = () => {
            if (hasFocus(editor)) report.current({ ...editor.getEditorState().read($readDraft), edited: false });
          };
          root.ownerDocument.addEventListener("selectionchange", settled);
          return () => root.ownerDocument.removeEventListener("selectionchange", settled);
        }),
      ),
    [editor, report],
  );
  return null;
}
