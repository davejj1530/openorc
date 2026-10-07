import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type KeyBinding,
} from "@codemirror/view";
import { lineSeparatorOf } from "./replacement";
import { appearance } from "./theme";
import type { CodeEditorProps } from "./types";

type CallerKeys = Pick<CodeEditorProps, "onSave" | "onFormat">;

/** A session's state outlives the editor that made it, so its key bindings find the mounted editor's callbacks here. */
const callers = new WeakMap<EditorView, () => CallerKeys>();

export function bindCaller(view: EditorView, keys: () => CallerKeys): void {
  callers.set(view, keys);
}

/** Returning true makes CodeMirror prevent the event's default, which App's shortcuts and the panel's Escape respect. */
const callerKeys: KeyBinding[] = [
  {
    key: "Mod-s",
    scope: "editor search-panel",
    run: (view) => {
      callers.get(view)?.().onSave();
      return true;
    },
  },
  {
    key: "Shift-Alt-f",
    run: (view) => {
      const format = callers.get(view)?.().onFormat;
      format?.();
      return Boolean(format);
    },
  },
];

const language = new Compartment();
const editability = new Compartment();
const prose = /\.(md|markdown|mdx|txt)$/i;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function createState(text: string, path: string, readOnly: boolean): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      EditorState.lineSeparator.of(lineSeparatorOf(text)),
      EditorView.contentAttributes.of({ "aria-label": fileName(path) }),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      prose.test(path) ? EditorView.lineWrapping : [],
      keymap.of([...callerKeys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      language.of([]),
      editability.of(EditorState.readOnly.of(readOnly)),
      appearance,
    ],
  });
}

export function setReadOnly(view: EditorView, readOnly: boolean): void {
  if (view.state.readOnly !== readOnly) view.dispatch({ effects: editability.reconfigure(EditorState.readOnly.of(readOnly)) });
}

/** Highlights the document once its language's chunk has loaded. A file type with no grammar stays plain text. */
export function loadLanguage(view: EditorView, path: string, alive: () => boolean): void {
  const description = LanguageDescription.matchFilename(languages, fileName(path));
  if (!description) return;
  const apply = (support: LanguageSupport) => {
    if (alive() && language.get(view.state) !== support) view.dispatch({ effects: language.reconfigure(support) });
  };
  if (description.support) apply(description.support);
  // A grammar chunk that fails to load leaves the file readable as plain text, which is all it can do.
  else void description.load().then(apply, () => undefined);
}
