const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only complete mention tokens match; email addresses and longer IDs stay literal. */
export function mentionNameText(names: ReadonlyMap<string, string>): (text: string) => string {
  if (!names.size) return (text) => text;
  const lookup = new Map([...names].map(([key, name]) => [key.toLowerCase(), name]));
  const alternatives = [...lookup.keys()].sort((a, b) => b.length - a.length).map(escape);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@/\\\\])@(${alternatives.join("|")})(?![\\p{L}\\p{N}_-])`, "giu");
  return (text) => text.replace(pattern, (_, prefix: string, key: string) => `${prefix}@${lookup.get(key.toLowerCase())!}`);
}

type MarkdownNode = { type?: string; tagName?: string; value?: string; children?: MarkdownNode[] };
const literalElements = new Set(["a", "code", "pre", "math", "script", "style"]);

/** Change rendered prose only. The original ledger, code and URLs remain exact. */
export function rehypeMentionNames(options: { names: readonly (readonly [string, string])[] }) {
  const display = mentionNameText(new Map(options.names));
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.tagName && literalElements.has(node.tagName)) return;
      if (node.type === "text" && node.value) node.value = display(node.value);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
