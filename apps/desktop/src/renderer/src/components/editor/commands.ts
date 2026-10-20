import type { Editor } from "@tiptap/react";
import { Code2, Heading2, Image, List, ListChecks, Minus, Text, Quote, ListOrdered } from "../icons";

export const insertCommands = [
  { id: "text", label: "Text", keywords: "paragraph normal", icon: Text, run: (editor: Editor) => editor.chain().focus().setParagraph().run() },
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    label: `Heading ${level}`,
    keywords: `h${level} heading`,
    icon: Heading2,
    run: (editor: Editor) => editor.chain().focus().setHeading({ level }).run(),
  })),
  { id: "bullet", label: "Bulleted list", keywords: "ul bullet list", icon: List, run: (editor: Editor) => editor.chain().focus().toggleBulletList().run() },
  { id: "ordered", label: "Numbered list", keywords: "ol numbered list", icon: ListOrdered, run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: "checklist", label: "Checklist", keywords: "task todo check", icon: ListChecks, run: (editor: Editor) => editor.chain().focus().toggleTaskList().run() },
  { id: "quote", label: "Quote", keywords: "blockquote quote", icon: Quote, run: (editor: Editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code block", keywords: "code fenced", icon: Code2, run: (editor: Editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: "divider", label: "Divider", keywords: "hr rule separator", icon: Minus, run: (editor: Editor) => editor.chain().focus().setHorizontalRule().run() },
  { id: "image", label: "Image", keywords: "image photo screenshot file insert", icon: Image, run: (_editor: Editor) => false },
];

export function matchingCommands(query: string) {
  return insertCommands.filter((command) => `${command.label} ${command.keywords}`.toLowerCase().includes(query.trim().toLowerCase()));
}
