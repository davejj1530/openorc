import { passageProofs, type ProofMark, type ProofNames } from "@openorc/client";

/**
 * Places a reply's proof marks. The reply's lines that call on something the turn did are known ahead (`marks`); this
 * finds each in the rendered text and ends that sentence with its marks, inside a line that can open what they stand
 * for. A paragraph or a list item's own words is a sentence; code, headings and tables carry none.
 */

type HastNode = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** The line that holds a sentence and its marks, and a mark, as the reply's renderer draws them. */
export const PROOF_LINE = "proof-line";
export const PROOF_MARK = "proof-mark";

/** Where a list item's own words end. */
const BLOCKS = new Set(["p", "ul", "ol", "pre", "blockquote", "table", "div", "hr", "details"]);
const LITERAL = new Set(["pre", "code", "table", "h1", "h2", "h3", "h4", "h5", "h6"]);

function decoded(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** What a passage says to a reader, and where its links point: a file may be named by its link alone. */
function said(nodes: HastNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.value ?? "";
      const href = node.tagName === "a" && typeof node.properties?.["href"] === "string" ? ` ${decoded(node.properties["href"])} ` : "";
      return said(node.children ?? []) + href;
    })
    .join("");
}

const element = (tagName: string, properties: Record<string, unknown>, children: HastNode[]): HastNode => ({ type: "element", tagName, properties, children });
/** Each mark after a gap, so it can take the next line when the sentence fills this one. */
const marksOf = (keys: string[]): HastNode[] => keys.flatMap((key) => [{ type: "text", value: " " }, element(PROOF_MARK, { dataProof: key }, [])]);

export function proofLines(options: { marks: ProofMark[]; names: ProofNames }) {
  return (tree: HastNode, file: { value?: unknown }) => {
    // The renderer works a reply part by part: only the marks whose line is in this part are placed here.
    const source = String(file.value ?? "");
    const waiting = new Set(options.marks.filter((mark) => source.includes(mark.line)).map((mark) => mark.key));
    const claimed = (words: HastNode[]): string[] => {
      const keys = waiting.size ? passageProofs(said(words), options.names).filter((key) => waiting.has(key)) : [];
      for (const key of keys) waiting.delete(key);
      return keys;
    };
    const item = (node: HastNode) => {
      const children = node.children ?? [];
      const end = children.findIndex((child) => child.type === "element" && BLOCKS.has(child.tagName ?? ""));
      const words = end < 0 ? children : children.slice(0, end);
      const keys = claimed(words);
      if (keys.length) node.children = [element(PROOF_LINE, {}, [...words, ...marksOf(keys)]), ...(end < 0 ? [] : children.slice(end))];
    };
    const visit = (parent: HastNode) => {
      parent.children = parent.children?.map((child) => {
        if (child.type !== "element" || LITERAL.has(child.tagName ?? "")) return child;
        if (child.tagName === "p") {
          const keys = claimed(child.children ?? []);
          return keys.length ? element(PROOF_LINE, {}, [{ ...child, children: [...(child.children ?? []), ...marksOf(keys)] }]) : child;
        }
        // A list item's own words come before the lists under it.
        if (child.tagName === "li") item(child);
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}
