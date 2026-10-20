import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Syntax colors from Shiki's github-light and github-dark, the themes every diff in the app uses, so a file reads the
 * same in the editor as in its diff. Light and dark switch with the app's `.dark` root class.
 */
const syntaxColors = {
  light: { comment: "#6a737d", keyword: "#d73a49", string: "#032f62", regexp: "#032f62", constant: "#005cc5", entity: "#6f42c1", tag: "#22863a", variable: "#e36209", invalid: "#b31d28" },
  dark: { comment: "#6a737d", keyword: "#f97583", string: "#9ecbff", regexp: "#dbedff", constant: "#79b8ff", entity: "#b392f0", tag: "#85e89d", variable: "#ffab70", invalid: "#fdaeb7" },
};

const syntaxVariables = (colors: Record<string, string>) => Object.fromEntries(Object.entries(colors).map(([name, color]) => [`--syntax-${name}`, color]));

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.operator, t.unit], color: "var(--syntax-keyword)" },
  { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue], color: "var(--syntax-string)" },
  { tag: [t.regexp, t.url], color: "var(--syntax-regexp)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.self, t.color, t.constant(t.variableName), t.standard(t.variableName), t.standard(t.typeName)], color: "var(--syntax-constant)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.typeName, t.definition(t.typeName), t.attributeName, t.macroName],
    color: "var(--syntax-entity)",
  },
  { tag: [t.tagName, t.quote, t.inserted], color: "var(--syntax-tag)" },
  { tag: t.escape, color: "var(--syntax-tag)", fontWeight: "bold" },
  { tag: [t.changed, t.special(t.variableName)], color: "var(--syntax-variable)" },
  { tag: [t.invalid, t.deleted], color: "var(--syntax-invalid)" },
  { tag: t.heading, color: "var(--syntax-constant)", fontWeight: "bold" },
  { tag: t.monospace, color: "var(--syntax-constant)" },
  { tag: t.link, color: "var(--syntax-regexp)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

const control = { height: "28px", padding: "0 12px", border: "none", borderRadius: "var(--radius-pill)", fontSize: "var(--text-sm)", verticalAlign: "middle" };

/** Every surface color is an app token, so the editor follows the palette, appearance and custom colors live. */
const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "var(--bg)", fontSize: "var(--text-sm)", ...syntaxVariables(syntaxColors.light) },
  ".dark &": syntaxVariables(syntaxColors.dark),
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "22px" },
  ".cm-content": { caretColor: "var(--ink)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  ".cm-selectionBackground": { background: "color-mix(in srgb, var(--selection) 60%, var(--bg))" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--surface-2)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--ink-4)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-3)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
  ".cm-specialChar": { color: "var(--bad)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--ok) 20%, transparent)" },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": { color: "var(--bad)", backgroundColor: "transparent" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 24%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 48%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--ok) 16%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--ink)" },
  ".cm-panels-top": { borderBottom: "none" },
  // One row of find controls whose field takes the slack, and replace on a row of its own when the file is editable.
  // A flex row ignores CodeMirror's <br>, so a full-width item after the find controls breaks the row instead.
  ".cm-panel.cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: "6px", padding: "6px 44px 6px 10px", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)" },
  ".cm-panel.cm-search > input, .cm-panel.cm-search > button:not([name=close]), .cm-panel.cm-search > label": { margin: "2px 0" },
  ".cm-panel.cm-search > .cm-textfield": { flex: "1 1 120px", minWidth: "0" },
  ".cm-panel.cm-search > br": { display: "none" },
  ".cm-panel.cm-search:has(> [name=replace])::after": { content: '""', flexBasis: "100%", order: "1" },
  ".cm-panel.cm-search > [name=replace], .cm-panel.cm-search > [name=replaceAll]": { order: "2" },
  ".cm-panel.cm-search label": { fontSize: "var(--text-sm)", color: "var(--ink-3)" },
  ".cm-panel.cm-search input[type=checkbox]": { margin: "0 4px 0 0", accentColor: "var(--accent)", verticalAlign: "-2px" },
  ".cm-textfield": { ...control, width: "min(180px, 100%)", backgroundColor: "var(--surface-2)", color: "var(--ink)", outline: "none" },
  ".cm-textfield:focus": { backgroundColor: "var(--surface-3)" },
  ".cm-button": { ...control, backgroundColor: "var(--surface-2)", backgroundImage: "none", color: "var(--ink-2)" },
  ".cm-button:hover": { backgroundColor: "var(--surface-3)", color: "var(--ink)" },
  ".cm-button:active": { backgroundImage: "none" },
  ".cm-panel.cm-search [name=close]": { top: "8px", right: "10px", width: "28px", height: "28px", borderRadius: "var(--radius-pill)", color: "var(--ink-3)", fontSize: "18px", lineHeight: "28px" },
  ".cm-panel.cm-search [name=close]:hover": { backgroundColor: "var(--surface-2)", color: "var(--ink)" },
});

/** The find panel's words in the app's sentence case. */
const phrases = EditorState.phrases.of({
  next: "Next",
  previous: "Previous",
  all: "All",
  "match case": "Match case",
  regexp: "Regex",
  "by word": "Whole word",
  replace: "Replace",
  "replace all": "Replace all",
  close: "Close",
});

export const appearance = [theme, syntaxHighlighting(highlight), phrases];
