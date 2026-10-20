import type { EditorState, StateEffect } from "@codemirror/state";
import type { LineRange } from "./types";

/** What an editor keeps for its buffer while unmounted. Type-only engine imports keep this module out of the editor's chunk. */
export interface EditorSession {
  state: EditorState;
  /** Where the editor last scrolled to, or the reveal it was last asked for if that came after. */
  scroll: StateEffect<unknown> | null;
  /** The text last reported to the caller or taken from it. */
  reported: string;
  /** The reveal last applied, so showing the buffer again doesn't jump back to a cited line. */
  revealed: LineRange | null;
}

const LIMIT = 20;
/** Most recently shown last. Holds mounted editors' sessions too, so closing one while it shows still drops it. */
const sessions = new Map<string, EditorSession>();

export function findSession(key: string): EditorSession | undefined {
  return sessions.get(key);
}

export function keepSession(key: string, session: EditorSession): void {
  sessions.delete(key);
  sessions.set(key, session);
  for (const oldest of sessions.keys()) {
    if (sessions.size <= LIMIT) break;
    sessions.delete(oldest);
  }
}

/** Drops a buffer's undo history, selection and scroll now, so reopening the file starts fresh. */
export function closeEditorSession(key: string): void {
  sessions.delete(key);
}

/** Whether `session` is still the one kept under `key`: false once it was closed or evicted. */
export function isKept(key: string, session: EditorSession): boolean {
  return sessions.get(key) === session;
}
