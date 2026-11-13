import { COMMAND_PRIORITY_CRITICAL, KEY_DOWN_COMMAND } from "lexical";
import { useEffect } from "react";
import { composing, useLatest } from "../shared";
import { useEditor } from "../editor";

/**
 * Hands each key to the composer before the editor's own handling: true for a key the composer took (Enter sending, a
 * list's arrows and picks), which the editor then leaves alone. A key an input method composes with never reaches it,
 * so Enter committing Japanese, Chinese or Korean text never sends. Keys it leaves keep the editor's meaning: Shift+Enter
 * starts a line, the arrows step over a mark, Backspace takes a mark whole.
 */
export function KeyboardPlugin({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => boolean }) {
  const editor = useEditor();
  const latest = useLatest(onKeyDown);
  useEffect(() => editor.registerCommand(KEY_DOWN_COMMAND, (event) => !composing(event) && latest.current(event), COMMAND_PRIORITY_CRITICAL), [editor, latest]);
  return null;
}
