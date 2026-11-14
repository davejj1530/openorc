import { PERSON_TAG } from "./message-marks";

type Node = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
const literal = new Set(["a", "code", "pre", "math", "script", "style"]);

/** A tagged teammate's display words, the same in a bubble, a copy and a screen reader. */
export function personTagText(body: string, nameOf: (id: string) => string | undefined): string {
  return body.replace(PERSON_TAG, (_, id: string) => `@${nameOf(id) ?? "Former member"}`);
}

/**
 * Draws each `@[user:ID]` in rendered prose as the person's name in plain blue words. Runs after sanitizing, so the
 * mark it adds is its own and the name inside it stays text. Code and links keep their exact words.
 */
export function rehypePersonTags(options: { names: readonly (readonly [string, string])[] }) {
  const names = new Map(options.names);
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (node.tagName && literal.has(node.tagName)) return;
      if (!node.children) return;
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type !== "text" || !child.value || !child.value.includes("@[user:")) {
          visit(child);
          return [child];
        }
        const out: Node[] = [];
        let at = 0;
        for (const match of child.value.matchAll(PERSON_TAG)) {
          if (match.index > at) out.push({ type: "text", value: child.value.slice(at, match.index) });
          out.push({
            type: "element",
            tagName: "mark",
            properties: { className: ["person-token"], dataPerson: match[1] },
            children: [{ type: "text", value: `@${names.get(match[1]!) ?? "Former member"}` }],
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
