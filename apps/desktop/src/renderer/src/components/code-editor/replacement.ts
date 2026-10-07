import type { ChangeSpec, EditorState } from "@codemirror/state";

/**
 * The line break a file uses. CodeMirror otherwise splits on any break and joins with "\n", which would rewrite a
 * CRLF file on its first save; with the file's own separator, its text comes back exactly as it was read.
 */
export function lineSeparatorOf(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? "\n";
}

/**
 * The one change that turns the document into `text`. Everything before the first difference and after the last one
 * stays, so a caret or scroll position outside the change doesn't move. Compared in document positions, where a line
 * break counts once whatever the file's separator. Null when they're equal.
 */
export function replacement(state: EditorState, text: string): ChangeSpec | null {
  const next = state.toText(text);
  const before = state.doc.sliceString(0, state.doc.length, "\n");
  const after = next.sliceString(0, next.length, "\n");
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < shorter - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return { from: start, to: before.length - end, insert: next.slice(start, after.length - end) };
}
