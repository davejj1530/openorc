import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, COPY_COMMAND, CUT_COMMAND, CUT_TAG, DROP_COMMAND, mergeRegister, PASTE_COMMAND } from "lexical";
import { useEffect } from "react";
import { useLatest } from "../shared";
import { useEditor } from "../editor";

/** Writes the selection to the clipboard as its words only, marks as the words they stand for. True when there was a selection to take. */
function copyWords(event: ClipboardEvent | KeyboardEvent | null): boolean {
  const selection = $getSelection();
  const data = event && "clipboardData" in event ? event.clipboardData : null;
  if (!event || !data || !selection || selection.isCollapsed()) return false;
  event.preventDefault();
  data.setData("text/plain", selection.getTextContent());
  return true;
}

/**
 * The draft's clipboard and drops. Pasted files are attached rather than written into the words, words paste as plain
 * text, and copy and cut give plain text only. Files dropped on the words belong to the composer's drop handling, which
 * attaches them, so the editor puts nothing of them in the text.
 */
export function ClipboardPlugin({ onFiles }: { onFiles: (files: File[]) => void }) {
  const editor = useEditor();
  const latest = useLatest(onFiles);
  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          PASTE_COMMAND,
          (event) => {
            const files = Array.from(("clipboardData" in event ? event.clipboardData?.files : null) ?? []);
            if (files.length === 0) return false;
            event.preventDefault();
            latest.current(files);
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(COPY_COMMAND, copyWords, COMMAND_PRIORITY_HIGH),
        editor.registerCommand(
          CUT_COMMAND,
          (event) => {
            if (!copyWords(event)) return false;
            editor.update(
              () => {
                const selection = $getSelection();
                if ($isRangeSelection(selection)) selection.removeText();
              },
              { tag: CUT_TAG },
            );
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          DROP_COMMAND,
          (event) => {
            if (!event.dataTransfer?.types.includes("Files")) return false;
            event.preventDefault();
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [editor, latest],
  );
  return null;
}
