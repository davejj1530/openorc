import { REDO_COMMAND, UNDO_COMMAND } from "lexical";
import { focusedComposerEditor } from "../components/composer-editor/editor";

/**
 * Edit > Undo and Edit > Redo from the menu bar. In a composer they step its own history, which the browser's commands
 * cannot reach; anywhere else they are the browser's own, as a text field expects.
 */
export function installEditHistory(): void {
  window.openorc.onEditHistory((action) => {
    const editor = focusedComposerEditor();
    if (editor) editor.dispatchCommand(action === "undo" ? UNDO_COMMAND : REDO_COMMAND, undefined);
    else document.execCommand(action);
  });
}
