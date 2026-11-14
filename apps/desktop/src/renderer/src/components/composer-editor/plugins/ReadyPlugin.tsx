import { $getRoot, COMMAND_PRIORITY_LOW, FOCUS_COMMAND, mergeRegister } from "lexical";
import { useEffect } from "react";
import { EXTERNAL, useLatest } from "../shared";
import { useEditor } from "../editor";

/** Says the person is about to write: as they focus the draft, and as they start a message in an empty one. A message written in from outside says nothing. */
export function ReadyPlugin({ onReady }: { onReady: (why: "focus" | "words") => void }) {
  const editor = useEditor();
  const latest = useLatest(onReady);
  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          FOCUS_COMMAND,
          () => {
            latest.current("focus");
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
          if (tags.has(EXTERNAL)) return;
          const words = (state: typeof editorState) => state.read(() => $getRoot().getTextContent().trim() !== "");
          if (!words(prevEditorState) && words(editorState)) latest.current("words");
        }),
      ),
    [editor, latest],
  );
  return null;
}
