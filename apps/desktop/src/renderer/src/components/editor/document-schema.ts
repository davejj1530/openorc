import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Paragraph from "@tiptap/extension-paragraph";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import { Markdown, MarkdownManager, type MarkdownExtensionOptions } from "@tiptap/markdown";
import { Extension } from "@tiptap/react";
import { marked, Marked } from "marked";
import { VerbatimBlock, VerbatimInline } from "./verbatim";

/** Markdown images are inline, so a paragraph that holds only an image stays a paragraph. */
const DocumentParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) =>
    token.tokens?.length === 1 && token.tokens[0]?.type === "image" ? helpers.createNode("paragraph", undefined, helpers.parseInline(token.tokens)) : Paragraph.config.parseMarkdown!(token, helpers),
});

/** A paragraph's continuation lines start without their indent, as CommonMark reads them; a list item's indent is not text. */
const SoftBreak = Extension.create({
  name: "softBreak",
  markdownTokenizer: {
    name: "softBreak",
    level: "inline",
    start: (src) => src.search(/\n[ \t]/),
    tokenize: (src) => {
      const indented = /^\n[ \t]+/.exec(src);
      return indented ? { type: "text", raw: indented[0], text: "\n" } : undefined;
    },
  },
});

/**
 * Each editor parses with its own marked instance. Tiptap registers extension
 * tokenizers on every editor it creates, so a shared instance collects copies
 * and parses slower with each task opened. Tiptap types the option as marked's
 * default export; an instance has every member it uses.
 */
const documentMarked = () => new Marked() as unknown as NonNullable<MarkdownExtensionOptions["marked"]>;

export function documentExtensions(image = Image) {
  return [
    StarterKit.configure({ paragraph: false, underline: false, link: { openOnClick: false, autolink: true } }),
    DocumentParagraph,
    TaskList,
    TaskItem.configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } }),
    TableKit.configure({ table: { resizable: false } }),
    image.configure({ inline: true }),
    VerbatimBlock,
    VerbatimInline,
    SoftBreak,
    Markdown.configure({ marked: documentMarked() }),
  ];
}

let manager: MarkdownManager | undefined;
export function markdownManager() {
  return (manager ??= new MarkdownManager({ marked: documentMarked(), extensions: documentExtensions() }));
}

export function hasPendingImages(source: string): boolean {
  let pending = false;
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === "image" && token.href.startsWith("openorc-pending://")) pending = true;
  });
  return pending;
}

export type SlashMatch = { from: number; to: number; query: string };
export function slashQuery(text: string, start: number, cursor: number): SlashMatch | null {
  const match = /^\/([\w -]*)$/.exec(text);
  return match ? { from: start, to: cursor, query: match[1]!.toLowerCase() } : null;
}
