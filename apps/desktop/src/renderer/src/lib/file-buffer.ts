import type { FileExpectation, FileRead, FileSnapshot, FileWriteResult, FolderPath } from "@openorc/protocol";
import type { Draft } from "./file-drafts";

/**
 * One open file as the editor shows it, decided by two values only: the file as last read, and the user's draft.
 * Derived on every render and never stored, so the tab's dot, the banners and Save can't disagree.
 */
export type BufferView =
  | { kind: "loading" }
  | { kind: "clean"; file: FileSnapshot }
  /** Unsaved edits on top of the file as it is. */
  | { kind: "dirty"; file: FileSnapshot; draft: Draft }
  /** Unsaved edits, and the file changed on disk since they began. Save waits for Keep mine or Use new version. */
  | { kind: "conflict"; file: FileSnapshot; draft: Draft }
  /** Unsaved edits, and the file is gone. Save creates it again. */
  | { kind: "deleted"; path: FolderPath; draft: Draft }
  | { kind: "missing"; path: FolderPath }
  | { kind: "unreadable"; path: FolderPath; reason: string };

export type EditableView = Extract<BufferView, { kind: "clean" | "dirty" | "conflict" | "deleted" }>;

/**
 * - not read yet, or its draft not loaded yet: loading, since typing then could overwrite a stored draft
 * - unreadable: unreadable, keeping any draft for when the file reads again
 * - missing: deleted with a draft, missing without
 * - a draft equal to the file is no edit at all: clean, whatever version it began on
 * - a draft begun on this version: dirty; begun on another: conflict
 */
export function bufferView(disk: FileRead | undefined, draft: Draft | null | undefined): BufferView {
  if (!disk || draft === undefined) return { kind: "loading" };
  if (disk.kind === "unreadable") return { kind: "unreadable", path: disk.path, reason: disk.reason };
  if (disk.kind === "missing") return draft ? { kind: "deleted", path: disk.path, draft } : { kind: "missing", path: disk.path };
  if (!draft || draft.text === disk.text) return { kind: "clean", file: disk };
  return draft.base === disk.version ? { kind: "dirty", file: disk, draft } : { kind: "conflict", file: disk, draft };
}

export function isEditable(view: BufferView): view is EditableView {
  return view.kind === "clean" || view.kind === "dirty" || view.kind === "conflict" || view.kind === "deleted";
}

/** Whether closing the file now would lose typing. */
export function hasUnsavedEdits(view: BufferView): boolean {
  return view.kind === "dirty" || view.kind === "conflict" || view.kind === "deleted";
}

/** What the editor holds: the draft's text, else the file's. Null when there is nothing to edit. */
export function bufferText(view: BufferView): string | null {
  if (view.kind === "clean") return view.file.text;
  return "draft" in view ? view.draft.text : null;
}

/**
 * The draft after the user's edit. Null when the text matches the file again, so undoing back to the saved text leaves
 * a clean buffer. A draft keeps the version it began on, which is what turns a later disk change into a conflict.
 */
export function draftAfterEdit(view: EditableView, text: string): Draft | null {
  if (view.kind === "deleted") return { text, base: view.draft.base };
  if (text === view.file.text) return null;
  return { text, base: view.kind === "clean" ? view.file.version : view.draft.base };
}

/** "Keep mine": the same text, now on the file as it is, so the next save replaces it on purpose. */
export function keepMine(view: Extract<BufferView, { kind: "conflict" }>): Draft {
  return { text: view.draft.text, base: view.file.version };
}

/** What Save sends. Null when there is nothing to save, or a conflict waits for the user's choice. */
export function saveRequest(view: BufferView): { path: FolderPath; text: string; expected: FileExpectation } | null {
  if (view.kind === "dirty") return { path: view.file.path, text: view.draft.text, expected: { kind: "version", version: view.file.version } };
  if (view.kind === "deleted") return { path: view.path, text: view.draft.text, expected: { kind: "absent" } };
  return null;
}

/** What Shift+Option+F formats: the text the editor holds, and its file. Null when there is nothing the user may edit. */
export function formatRequest(view: BufferView): { path: FolderPath; text: string } | null {
  if (view.kind === "deleted") return { path: view.path, text: view.draft.text };
  if (!isEditable(view) || view.file.readOnly) return null;
  return { path: view.file.path, text: "draft" in view ? view.draft.text : view.file.text };
}

/**
 * The file and the draft once a save answers, given the buffer as it stands at that moment.
 * - saved: the file is what was written, formatted or as sent, at its new version. What the editor holds now becomes a
 *   draft on that version unless it is exactly what was sent, so typing or undo during the save is kept and never
 *   overwritten, by the saved text or by its formatting.
 * - conflict: the file as it is now, and the draft as it was: the banner shows.
 */
export function afterSave(result: FileWriteResult, sent: string, now: BufferView): { disk: FileRead; draft: Draft | null } {
  const draft = "draft" in now ? now.draft : null;
  if (result.kind === "conflict") return { disk: result.current, draft };
  const disk: FileRead = { kind: "file", root: result.root, path: result.path, absolutePath: result.absolutePath, version: result.version, text: result.text ?? sent, readOnly: null };
  const holds = bufferText(now) ?? sent;
  return { disk, draft: holds === sent ? null : { text: holds, base: result.version } };
}
