import { Extension } from "@tiptap/react";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { alignBlocks, type DiffBlock, type Segment } from "@openorc/client";

type Textblock = DiffBlock & { pos: number; size: number; map: number[] };

/** An image or other inline object holds one place in a block's text, so word positions still map back to the document. */
const OBJECT = "\uFFFC";
export const refineMarksKey = new PluginKey<DecorationSet>("refineMarks");

function textblocks(doc: DocumentNode): Textblock[] {
  const blocks: Textblock[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    let identity = "";
    const map: number[] = [];
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      if (child.isText) {
        for (let k = 0; k < child.text!.length; k++) map.push(at + k);
        text += child.text;
        identity += child.text;
      } else {
        map.push(at);
        text += child.type.name === "hardBreak" ? "\n" : OBJECT;
        identity += `[${child.type.name}:${String(child.attrs["src"] ?? "")}]`;
      }
    });
    map.push(pos + node.nodeSize - 1);
    if (text.trim()) blocks.push({ key: `${node.type.name}:${String(node.attrs["level"] ?? "")}:${String(node.attrs["checked"] ?? "")}:${identity}`, text, pos, size: node.nodeSize, map });
    return false;
  });
  return blocks;
}

/** Removed text goes between top-level blocks, ahead of whatever replaced it. */
function topLevelStart(doc: DocumentNode, pos: number): number {
  const inside = doc.resolve(pos + 1);
  return inside.depth >= 1 ? inside.before(1) : pos;
}

function removedText(texts: string[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "refine-removed";
  root.contentEditable = "false";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "refine-removed-toggle";
  toggle.textContent = "Show removed text";
  toggle.setAttribute("aria-expanded", "false");
  const body = document.createElement("div");
  body.className = "refine-removed-text";
  body.hidden = true;
  for (const text of texts) {
    const line = document.createElement("p");
    line.textContent = text;
    body.append(line);
  }
  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? "Show removed text" : "Hide removed text";
    toggle.setAttribute("aria-expanded", String(!body.hidden));
  });
  root.append(toggle, body);
  return root;
}

function deletedWords(text: string): HTMLElement {
  const span = document.createElement("del");
  span.className = "refine-del";
  span.textContent = text.replaceAll(OBJECT, "");
  return span;
}

function wordMarks(block: Textblock, segments: Segment[]): Decoration[] {
  const marks: Decoration[] = [];
  let offset = 0;
  for (const segment of segments) {
    if (segment.kind === "del") {
      marks.push(Decoration.widget(block.map[offset]!, () => deletedWords(segment.text), { side: -1, kind: "deleted", ignoreSelection: true }));
      continue;
    }
    const end = offset + segment.text.length;
    if (segment.kind === "ins" && end > offset) marks.push(Decoration.inline(block.map[offset]!, block.map[end - 1]! + 1, { class: "refine-ins" }, { kind: "inserted" }));
    offset = end;
  }
  return marks;
}

export function refineDecorations(doc: DocumentNode, baseDoc: DocumentNode): DecorationSet {
  const base = textblocks(baseDoc);
  const next = textblocks(doc);
  const decorations: Decoration[] = [];
  let removed: string[] = [];
  const placeRemoved = (pos: number) => {
    if (!removed.length) return;
    const texts = removed;
    removed = [];
    const key = `removed-${decorations.length}`;
    decorations.push(Decoration.widget(pos, () => removedText(texts), { side: -1, key, kind: "removed", ignoreSelection: true, stopEvent: () => true }));
  };
  for (const op of alignBlocks(base, next)) {
    if (op.kind === "removed") {
      removed.push(base[op.base]!.text.replaceAll(OBJECT, "").trim());
      continue;
    }
    const block = next[op.next]!;
    placeRemoved(topLevelStart(doc, block.pos));
    if (op.kind === "added") decorations.push(Decoration.node(block.pos, block.pos + block.size, { class: "refine-added" }, { kind: "added" }));
    if (op.kind === "changed") decorations.push(...wordMarks(block, op.segments));
  }
  placeRemoved(doc.content.size);
  return DecorationSet.create(doc, decorations);
}

export const RefineMarks = Extension.create({
  name: "refineMarks",
  addProseMirrorPlugins: () => [
    new Plugin<DecorationSet>({
      key: refineMarksKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, value) => tr.getMeta(refineMarksKey) ?? value.map(tr.mapping, tr.doc),
      },
      props: { decorations: (state) => refineMarksKey.getState(state) },
    }),
  ],
});

/** A gutter line sits at the document's edge, however deep in a list its block is. */
export function alignGutters(root: HTMLElement): void {
  const left = root.getBoundingClientRect().left;
  for (const element of root.querySelectorAll<HTMLElement>(".refine-added, .refine-removed")) element.style.setProperty("--refine-indent", `${element.getBoundingClientRect().left - left}px`);
}
