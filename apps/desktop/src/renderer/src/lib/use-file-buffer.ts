import { useEffect, useState } from "react";
import type { Query } from "@tanstack/react-query";
import { create } from "zustand";
import type { FileRead, FileWriteResult, FormatResult, RpcParams } from "@openorc/protocol";
import { closeEditorSession } from "../components/code-editor";
import { afterSave, bufferText, bufferView, draftAfterEdit, formatRequest, hasUnsavedEdits, isEditable, keepMine, saveRequest, type BufferView } from "./file-buffer";
import { fileKey, flushDrafts, loadDraft, putDraft, useDrafts, type FileKey } from "./file-drafts";
import type { FileSelection } from "./layout";
import { queryClient, useRpc } from "./query";
import { core } from "./rpc";

type ReadParams = RpcParams<"files.read">;

const readParams = (selection: FileSelection): ReadParams => ({ scope: selection.scope, path: selection.path });
const cachedRead = (params: ReadParams) => queryClient.getQueryData<FileRead>(["files.read", params]);
/** Every cached read of one file, whatever path its page opened it by. Each holds a FileRead, as its key says. */
const readsOf = (key: FileKey) => ({
  predicate: (query: Query) => query.queryKey[0] === "files.read" && query.state.data !== undefined && fileKey(query.state.data as FileRead) === key,
});

/** The buffer from the latest read and draft, not the last render's: edits and saves decide from what is true now. */
function currentBuffer(params: ReadParams): { key: FileKey; view: BufferView } | null {
  const disk = cachedRead(params);
  if (!disk) return null;
  const key = fileKey(disk);
  return { key, view: bufferView(disk, useDrafts.getState().loaded.get(key)) };
}

interface SaveState {
  saving: ReadonlySet<FileKey>;
  /** The last failed save's message per file, until the next edit. */
  errors: ReadonlyMap<FileKey, string>;
  /** A quiet word on the last save or format per file, such as why it wasn't formatted, until the next edit. */
  notes: ReadonlyMap<FileKey, string>;
}

const useSaves = create<SaveState>(() => ({ saving: new Set(), errors: new Map(), notes: new Map() }));

function setSaving(key: FileKey, saving: boolean): void {
  useSaves.setState((state) => {
    const next = new Set(state.saving);
    if (saving) next.add(key);
    else next.delete(key);
    return { saving: next };
  });
}

function setMessage(kind: "errors" | "notes", key: FileKey, message: string | null): void {
  if ((useSaves.getState()[kind].get(key) ?? null) === message) return;
  useSaves.setState((state) => {
    const messages = new Map(state[kind]);
    if (message === null) messages.delete(key);
    else messages.set(key, message);
    return kind === "errors" ? { errors: messages } : { notes: messages };
  });
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Applies a save's answer to every read of the file and to its draft in one task, so no render sees one without the
 * other: a render between them would hand the editor the old text, which it would take as a new disk version.
 */
function settle(params: ReadParams, key: FileKey, result: FileWriteResult, sent: string): void {
  void queryClient.cancelQueries(readsOf(key));
  const now = currentBuffer(params);
  const next = afterSave(result, sent, now?.key === key ? now.view : { kind: "loading" });
  queryClient.setQueriesData<FileRead>(readsOf(key), next.disk);
  putDraft(key, next.draft);
}

export type SaveOutcome = { kind: "saved" | "conflict" | "nothing" } | { kind: "failed"; message: string };

/** Saves the file a page shows: Cmd+S, the Save button or the close prompt. One save per file runs at a time. */
export async function saveFile(selection: FileSelection): Promise<SaveOutcome> {
  const params = readParams(selection);
  const read = cachedRead(params);
  if (read) await loadDraft(fileKey(read));
  const now = currentBuffer(params);
  const request = now ? saveRequest(now.view) : null;
  if (!now || !request || useSaves.getState().saving.has(now.key)) return { kind: "nothing" };
  const { key } = now;
  setSaving(key, true);
  try {
    const result = await core.call("files.write", { scope: params.scope, ...request });
    settle(params, key, result, request.text);
    setMessage("notes", key, result.kind === "saved" && result.formatError ? `Saved without formatting. ${result.formatError}` : null);
    return { kind: result.kind };
  } catch (error) {
    const message = errorMessage(error);
    setMessage("errors", key, message);
    return { kind: "failed", message };
  } finally {
    setSaving(key, false);
  }
}

function formatNote(result: FormatResult): string | null {
  if (result.kind === "unavailable") return "No formatter for this file.";
  return result.kind === "failed" ? `Couldn't format. ${result.message}` : null;
}

/**
 * Shift+Option+F: what the editor holds, as the file's formatter writes it. The answer lands as an edit, so it is one
 * undo step and saves like typing. Typing during the format wins: an answer for text the editor no longer holds is dropped.
 */
export async function formatFile(selection: FileSelection): Promise<void> {
  const params = readParams(selection);
  const before = currentBuffer(params);
  const request = before ? formatRequest(before.view) : null;
  if (!before || !request) return;
  try {
    const result = await core.call("files.format", { scope: params.scope, ...request });
    const now = currentBuffer(params);
    if (result.kind === "formatted" && now?.key === before.key && isEditable(now.view) && bufferText(now.view) === request.text) putDraft(now.key, draftAfterEdit(now.view, result.text));
    setMessage("notes", before.key, formatNote(result));
  } catch (error) {
    setMessage("notes", before.key, `Couldn't format. ${errorMessage(error)}`);
  }
}

/** The file a tab shows, when closing the tab would lose typing; null otherwise. Reads only what is in memory. */
export function unsavedFileOf(selection: FileSelection): FileKey | null {
  const disk = cachedRead(readParams(selection));
  if (!disk) return null;
  const key = fileKey(disk);
  const { keys, loaded } = useDrafts.getState();
  const draft = loaded.get(key);
  const unsaved = draft === undefined ? keys.has(key) : hasUnsavedEdits(bufferView(disk, draft));
  return unsaved ? key : null;
}

/** "Don't save": the draft and the undo history go, so the file next opens as it is on disk. */
export function discardFile(key: FileKey): void {
  putDraft(key, null);
  closeEditorSession(key);
  void flushDrafts();
}

/** Whether a file tab holds unsaved edits, for its dot. Reads the file once if no page has. */
export function useUnsavedFile(selection: FileSelection): boolean {
  const params = readParams(selection);
  const disk = useRpc("files.read", params, { enabled: cachedRead(params) === undefined }).data;
  const key = disk ? fileKey(disk) : null;
  const stored = useDrafts((state) => (key ? state.keys.has(key) : false));
  const draft = useDrafts((state) => (key ? state.loaded.get(key) : undefined));
  useEffect(() => {
    if (key && stored) void loadDraft(key);
  }, [key, stored]);
  return draft === undefined ? stored : hasUnsavedEdits(bufferView(disk, draft));
}

export interface FileBuffer {
  /** The draft and editor session key, once the file has been read. */
  key: FileKey | null;
  view: BufferView;
  /** What the editor shows, or null when there is nothing to edit. */
  text: string | null;
  /** Why the file can't be edited, or null. */
  readOnly: string | null;
  saving: boolean;
  /** The last save's error, until the next edit. */
  error: string | null;
  /** A quiet word on the last save or format, such as why it wasn't formatted, until the next edit. */
  note: string | null;
  /** The read itself: failure, and a refresh for edits made outside OpenOrc. */
  read: { error: Error | null; refreshing: boolean; refresh: () => void };
  edit: (text: string) => void;
  save: () => void;
  format: () => void;
  keepMine: () => void;
  /** Drops the draft: "Use new version" in a conflict, "Discard" for a deleted file. */
  discard: () => void;
  /** Set when the user answers the conflict banner, so typing and Cmd+Z go straight back to the editor. */
  focusRequest: object | null;
}

/** One file page's buffer: the read, refreshed by diff pushes, plus the draft. Pure rules in file-buffer.ts decide everything. */
export function useFileBuffer(selection: FileSelection): FileBuffer {
  const params = readParams(selection);
  const query = useRpc("files.read", params);
  const disk = query.data;
  const key = disk ? fileKey(disk) : null;
  const draft = useDrafts((state) => (key ? state.loaded.get(key) : undefined));
  const saving = useSaves((state) => (key ? state.saving.has(key) : false));
  const error = useSaves((state) => (key ? (state.errors.get(key) ?? null) : null));
  const note = useSaves((state) => (key ? (state.notes.get(key) ?? null) : null));
  const [focusRequest, setFocusRequest] = useState<object | null>(null);
  useEffect(() => {
    if (key) void loadDraft(key);
  }, [key]);
  const view = bufferView(disk, draft);
  return {
    key,
    view,
    text: bufferText(view),
    readOnly: "file" in view ? view.file.readOnly : null,
    saving,
    error,
    note,
    read: { error: query.error, refreshing: query.isFetching, refresh: () => void query.refetch() },
    edit: (text) => {
      const now = currentBuffer(params);
      if (!now || !isEditable(now.view)) return;
      setMessage("errors", now.key, null);
      setMessage("notes", now.key, null);
      putDraft(now.key, draftAfterEdit(now.view, text));
    },
    save: () => void saveFile(selection),
    format: () => void formatFile(selection),
    keepMine: () => {
      const now = currentBuffer(params);
      if (now?.view.kind === "conflict") putDraft(now.key, keepMine(now.view));
      setFocusRequest({});
    },
    discard: () => {
      if (key) putDraft(key, null);
      setFocusRequest({});
    },
    focusRequest,
  };
}
