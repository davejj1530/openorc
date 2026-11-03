import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput, LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { editorLanguage } from "@openorc/protocol";
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
import { intelligenceExtensions } from "./intelligence";

type CallerKeys = Pick<CodeEditorProps, "onSave" | "onFormat" | "lineWrapping" | "onLineWrappingChange">;

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
  {
    // VS Code's Toggle Word Wrap. On a Mac, Option+Z arrives as "Ω"; CodeMirror matches it by key code.
    key: "Alt-z",
    run: (view) => {
      const keys = callers.get(view)?.();
      keys?.onLineWrappingChange?.(!keys.lineWrapping);
      return Boolean(keys?.onLineWrappingChange);
    },
  },
];

const language = new Compartment();
const editability = new Compartment();
const wrapping = new Compartment();
const prose = /\.(md|markdown|mdx|txt)$/i;
const wrapped = (wrap: boolean) => (wrap ? EditorView.lineWrapping : []);
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function createState(text: string, path: string, readOnly: boolean, lineWrapping: boolean): EditorState {
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
      codeFolding(),
      prose.test(path) ? [] : foldGutter(),
      editorLanguage(path) ? [lintGutter(), intelligenceExtensions] : [],
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      wrapping.of(wrapped(lineWrapping)),
      keymap.of([...callerKeys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab]),
      language.of([]),
      editability.of(EditorState.readOnly.of(readOnly)),
      appearance,
    ],
  });
}

export function setReadOnly(view: EditorView, readOnly: boolean): void {
  if (view.state.readOnly !== readOnly) view.dispatch({ effects: editability.reconfigure(EditorState.readOnly.of(readOnly)) });
}

/** Keeps the line at the top of the view where it is while every line above it rewraps. */
export function setLineWrapping(view: EditorView, wrap: boolean): void {
  if ((wrapping.get(view.state) === EditorView.lineWrapping) === wrap) return;
  view.dispatch({ effects: [wrapping.reconfigure(wrapped(wrap)), view.scrollSnapshot()] });
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
