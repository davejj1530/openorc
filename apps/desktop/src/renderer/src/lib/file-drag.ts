import type { FileScope } from "@openorc/protocol";
import { filesKey } from "./files-tool";

/** Private drag type: only a row of this window's Files tool can put a path in a composer. */
export const FILE_DRAG_TYPE = "application/x-openorc-file";

/** A file or folder dragged out of the Files tool, by its place in its conversation's folder. */
export interface DraggedFile {
  /** `filesKey` of the folder the path is in; a composer takes it only for its own folder. */
  scope: string;
  path: string;
  folder: boolean;
}

let dragged: DraggedFile | null = null;

export function startFileDrag(transfer: DataTransfer, scope: FileScope, path: string, folder: boolean): void {
  dragged = { scope: filesKey(scope), path, folder };
  transfer.effectAllowed = "copy";
  transfer.setData(FILE_DRAG_TYPE, path);
}

export function endFileDrag(): void {
  dragged = null;
}

// A drop can take the composer out from under the drag, so the window ends it too, after the drop's own handlers.
window.addEventListener("dragend", endFileDrag);
window.addEventListener("drop", () => setTimeout(endFileDrag));

/** The file being dragged, if this window started it. While dropping, the transfer must still carry the same path. */
export function draggedFile(transfer: DataTransfer, dropping = false): DraggedFile | null {
  if (!dragged || !transfer.types.includes(FILE_DRAG_TYPE)) return null;
  return !dropping || transfer.getData(FILE_DRAG_TYPE) === dragged.path ? dragged : null;
}

/** The text a dropped path puts in the prompt: the path the `@` picker would write, a folder ending in `/`. */
export function fileReferenceText(file: Pick<DraggedFile, "path" | "folder">): string {
  return file.folder ? `${file.path}/` : file.path;
}

/** `text` with `insert` at `at`, set off from the words on either side by a space. */
export function insertReference(text: string, at: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = /^\s/.test(after) ? "" : " ";
  const placed = `${before}${lead}${insert}${trail}`;
  return { text: `${placed}${after}`, caret: placed.length };
}
