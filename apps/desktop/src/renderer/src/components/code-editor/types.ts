/** 1-based, inclusive lines to select and scroll into view. */
export interface LineRange {
  start: number;
  end: number;
}

export interface CodeEditorProps {
  /**
   * One buffer's editing session. Its undo history, selection and scroll outlive unmounting (a tab switch, a closed
   * panel) while the key is among the 20 most recently shown. An older session loses its history; its text stays
   * with the caller.
   */
  sessionKey: string;
  /** Picks the language and line wrapping. The editor never reads or writes files. */
  path: string;
  /**
   * The buffer's text. A value equal to the last one this editor reported, or was given, changes nothing, so the
   * caller can render it back freely. A different value replaces the document as one undo step, changing only the
   * range that differs so the caret and scroll stay put: a disk refresh, "Use new version", a format.
   */
  text: string;
  readOnly: boolean;
  /** A new object selects and reveals its lines once per session. The same object again does nothing. */
  reveal: LineRange | null;
  /**
   * The document's text after every change the user makes, undo included, reported in the same task as the change.
   * The caller's state is therefore never behind the editor when a disk refresh arrives. Changes that came from
   * `text` are not reported.
   */
  onChange: (text: string) => void;
  /** Cmd+S, from the document or its find panel. */
  onSave: () => void;
  /** Shift+Option+F. Without it the keys pass through. */
  onFormat?: () => void;
  /** A new object moves keyboard focus into the editor once, as after the user answers the conflict banner. */
  focusRequest?: object | null;
}
