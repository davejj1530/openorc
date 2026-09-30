import { Mark, Node } from "@tiptap/react";
import { Lexer } from "marked";

// Markdown the editor has no rich form for (raw HTML, $$ math, footnotes, linked
// images) stays exactly as written, so a document always opens in rich text and
// never loses it. HTML uses marked's own rules, so it is found where marked finds it.
const htmlBlock = Lexer.rules.block.gfm.html;
const htmlTag = Lexer.rules.inline.gfm.tag;
const mathBlock = /^ {0,3}\$\$[^$\n]*\n(?:[^\n]*\n)*? {0,3}\$\$[ \t]*(?:\n+|$)/;
const mathInline = /^\$\$(?:\\[\s\S]|[^\\$]|\$(?!\$))+?\$\$/;
// A definition runs to the next blank line or the next definition.
const footnoteDefinition = /^ {0,3}\[\^[^\]\s]+\]:[^\n]*(?:\n(?![ \t]*(?:\n|$))(?! {0,3}\[\^[^\]\s]+\]:)[^\n]*)*(?:\n+|$)/;
const footnoteReference = /^\[\^[^\]\s]+\](?![(:[])/;
// Images carry no marks, so an image inside a link would lose the link.
const linkedImage = /^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/;

/** Block source kept as written. It edits as plain text, like a code block. */
export const VerbatimBlock = Node.create({
  name: "verbatimBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: "pre[data-verbatim]", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-verbatim": "", class: "task-verbatim", spellcheck: "false" }, 0],
  addKeyboardShortcuts() {
    return {
      // An emptied block turns back into a paragraph, like an emptied code block.
      Backspace: ({ editor }) => {
        const { empty, $anchor } = editor.state.selection;
        return empty && $anchor.parent.type.name === this.name && $anchor.parent.content.size === 0 && editor.commands.clearNodes();
      },
    };
  },
  markdownTokenizer: {
    name: "verbatimBlock",
    level: "block",
    // Math may interrupt a paragraph, like a code fence; the other blocks may not.
    start: (src) => {
      const fence = /(?:^|\n) {0,3}\$\$/.exec(src);
      return fence ? fence.index + (fence[0].startsWith("\n") ? 1 : 0) : -1;
    },
    tokenize: (src) => {
      const raw = htmlBlock.exec(src)?.[0] ?? mathBlock.exec(src)?.[0] ?? footnoteDefinition.exec(src)?.[0];
      return raw ? { type: "verbatimBlock", raw, text: raw.replace(/\s+$/, "") } : undefined;
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode("verbatimBlock", undefined, token.text ? [helpers.createTextNode(token.text)] : []),
  renderMarkdown: (node) => (node.content ?? []).map((child) => child.text ?? "").join(""),
});

/** Inline source kept as written: HTML tags, $$ math, footnote references, and linked images. */
export const VerbatimInline = Mark.create({
  name: "verbatimInline",
  code: true,
  inclusive: false,
  parseHTML: () => [{ tag: "span[data-verbatim]" }],
  renderHTML: () => ["span", { "data-verbatim": "", class: "task-verbatim-inline", spellcheck: "false" }, 0],
  markdownTokenizer: {
    name: "verbatimInline",
    level: "inline",
    start: (src) => src.search(/<|\$\$|\[[!^]/),
    tokenize: (src) => {
      const raw = htmlTag.exec(src)?.[0] ?? mathInline.exec(src)?.[0] ?? footnoteReference.exec(src)?.[0] ?? linkedImage.exec(src)?.[0];
      return raw ? { type: "verbatimInline", raw, text: raw } : undefined;
    },
  },
  parseMarkdown: (token, helpers) => helpers.applyMark("verbatimInline", [helpers.createTextNode(token.raw ?? "")]),
  renderMarkdown: (node, helpers) => helpers.renderChildren(node),
});
