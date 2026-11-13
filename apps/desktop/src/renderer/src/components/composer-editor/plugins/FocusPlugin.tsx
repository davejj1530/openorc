import { useEffect } from "react";
import { useEditor } from "../editor";

/** Takes focus as the composer mounts, the caret at the end of any draft it opens with, as a text field's autofocus does. */
export function FocusPlugin({ autoFocus }: { autoFocus: boolean }) {
  const editor = useEditor();
  useEffect(() => {
    if (!autoFocus) return;
    // Placing the caret focuses the page's selection where it can; the root itself takes focus where it did not.
    editor.focus(() => editor.getRootElement()?.focus({ preventScroll: true }), { defaultSelection: "rootEnd" });
    // Only as it mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  return null;
}
