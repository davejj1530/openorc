import { PERSON_TAG } from "./message-marks";

type Node = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
const literal = new Set(["script", "style"]);

/** A tagged teammate's display words, the same in a bubble, a copy and a screen reader. */
export function personTagText(body: string, nameOf: (id: string) => string | undefined): string {
  return body.replace(PERSON_TAG, (_, id: string) => `@${nameOf(id) ?? "Former member"}`);
}

/**
 * Stands each tag in for a private-use marker before Markdown reads the words, so an id that looks like an address
 * or holds Markdown's own characters is never linked or styled, and the marker is drawn back as the name.
 */
export function holdPersonTags(body: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const text = body.replace(PERSON_TAG, (_, id: string) => `\uE000${ids.push(id) - 1}\uE001`);
  return { text, ids };
}
const HELD = /\uE000(\d+)\uE001/g;

/**
 * Draws each held tag in rendered prose as the person's name in plain blue words. Runs after sanitizing, so the
 * mark it adds is its own and the name inside it stays text.
 */
export function rehypePersonTags(options: { names: readonly (readonly [string, string])[]; ids: readonly string[] }) {
  const names = new Map(options.names);
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (node.tagName && literal.has(node.tagName)) return;
      if (!node.children) return;
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type !== "text" || !child.value || !child.value.includes("\uE000")) {
          visit(child);
          return [child];
        }
        const out: Node[] = [];
        let at = 0;
        for (const match of child.value.matchAll(HELD)) {
          const id = options.ids[Number(match[1])] ?? "";
          if (match.index > at) out.push({ type: "text", value: child.value.slice(at, match.index) });
          out.push({
            type: "element",
            tagName: "mark",
            properties: { className: ["person-token"], dataPerson: id },
            children: [{ type: "text", value: `@${names.get(id) ?? "Former member"}` }],
          });
          at = match.index + match[0].length;
        }
        if (at < child.value.length) out.push({ type: "text", value: child.value.slice(at) });
        return out;
      });
    };
    visit(tree);
  };
}
