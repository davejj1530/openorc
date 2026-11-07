import { editorLanguage, editorText, FolderPath, type EditorDocument, type EditorFix, type EditorQuery, type FileRead, type FileScope } from "@openorc/protocol";
import { queryClient } from "./client";
import { bufferView, draftAfterEdit, isEditable } from "./file-buffer";
import { fileIdentity, fileKey, loadDraft, putDraft, useDrafts } from "./file-drafts";
import { core } from "./rpc";

/** A request is a complete snapshot, so another pane or window cannot leave stale unsaved text in the language service. */
export function editorDocuments(root: string, path: string, text: string): EditorDocument[] {
  const documents = new Map<string, EditorDocument>();
  const drafts = useDrafts.getState().loaded;
  for (const [key, draft] of drafts) {
    if (!draft) continue;
    const file = fileIdentity(key);
    if (file?.root === root && editorLanguage(file.path)) documents.set(file.path, { path: file.path, text: editorText(draft.text) });
  }
  const current = FolderPath.parse(path);
  documents.set(current, { path: current, text: editorText(text) });
  return [...documents.values()];
}

export function queryEditor(input: { scope: FileScope; root: string; path: string; text: string; query: EditorQuery }) {
  return core.call("editor.query", {
    scope: input.scope,
    expectedRoot: input.root,
    path: FolderPath.parse(input.path),
    documents: editorDocuments(input.root, input.path, input.text),
    query: input.query,
  });
}

/** Validate every target before changing any draft. TypeScript's changes are reviewable and saved by the usual versioned write. */
export async function applyEditorFix(scope: FileScope, root: string, fix: EditorFix): Promise<void> {
  const prepared = await Promise.all(
    fix.changes.map(async (change) => {
      const params = { scope, path: change.path };
      const disk = await core.call("files.read", params);
      if (disk.kind !== "file" || disk.readOnly || disk.root !== root) throw new Error("A file in this fix cannot be edited. Refresh and try again.");
      const key = fileKey(disk);
      await loadDraft(key);
      return { change, params, disk, key };
    }),
  );
  // Nothing yields between checking all buffers and applying them. Typing while the reads were in flight wins.
  const changes = prepared.map(({ change, params, disk, key }) => {
    const draft = useDrafts.getState().loaded.get(key) ?? null;
    const view = bufferView(disk, draft);
    const before = draft?.text ?? disk.text;
    if (editorText(before) !== change.before || !isEditable(view)) throw new Error("The code changed after this fix was offered. Request quick fixes again.");
    const after = before.includes("\r\n") ? change.after.replace(/\n/g, "\r\n") : change.after;
    return { params, disk, key, draft: draftAfterEdit(view, after) };
  });
  for (const change of changes) {
    void queryClient.cancelQueries({ queryKey: ["files.read", change.params], exact: true });
    for (const [key, read] of queryClient.getQueriesData<FileRead>({ queryKey: ["files.read"] })) if (read && fileKey(read) === change.key) queryClient.setQueryData(key, change.disk);
    queryClient.setQueryData(["files.read", change.params], change.disk);
    putDraft(change.key, change.draft);
  }
}
