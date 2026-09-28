import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { marked } from "marked";
import { getSchema } from "@tiptap/react";

export function documentExtensions(image = Image) {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, underline: false, link: { openOnClick: false, autolink: true } }),
    TaskList,
    TaskItem.configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } }),
    TableKit.configure({ table: { resizable: false } }),
    image,
    Markdown,
  ];
}

let manager: MarkdownManager | undefined;
export function markdownManager() {
  return (manager ??= new MarkdownManager({ extensions: documentExtensions() }));
}
let schema: ReturnType<typeof getSchema> | undefined;

/** Compare rendered semantics before letting a rich edit rewrite an existing document. */
export function canEditRichly(source: string): boolean {
  if (!source.trim()) return true;
  try {
    let unsupported = false;
    marked.walkTokens(marked.lexer(source), (token) => {
      if (token.type === "html") unsupported = true;
      if (token.type === "heading" && token.depth > 3) unsupported = true;
      if (token.type === "text" && /\$[^\n$]+\$|\\\(|\\\[/.test(token.raw)) unsupported = true;
      if (token.type === "image" && !safeImageSource(token.href)) unsupported = true;
    });
    if (unsupported || /^\s*\$\$/m.test(source)) return false;
    const document = (schema ??= getSchema(documentExtensions())).nodeFromJSON(markdownManager().parse(source));
    document.check();
    const roundTrip = markdownManager().serialize(document.toJSON());
    const semantic = (md: string) => marked.parse(md, { async: false }).trim().replace(/>\n+</g, "><");
    return semantic(source) === semantic(roundTrip);
  } catch {
    return false;
  }
}

export function safeImageSource(src: string): boolean {
  return /^https?:\/\//i.test(src) || /^openorc-asset:\/\/attachments\/[a-f0-9-]+\.(png|jpg|gif|webp)$/.test(src) || /^openorc-pending:\/\/[a-f0-9-]+$/.test(src);
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
