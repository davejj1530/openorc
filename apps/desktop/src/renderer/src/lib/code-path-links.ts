/**
 * Agents name files in inline code, `src/app.ts` or `src/app.ts:42`, far more often than as Markdown links. This turns
 * such code into a link to the file, which the transcript's links open in the Files tool.
 *
 * Only what reads as a path is taken: a folder and a file name with an extension, or an absolute path, with no spaces
 * or shell characters. A bare name like `app.ts` is left alone, since nothing says which folder it is in, and so is
 * everything that merely has dots, like `useLayout.getState`, and a path from a home folder, like `~/.claude/x.json`,
 * which a link would read as a folder named `~` in the conversation's.
 */

const SEGMENT = String.raw`[\p{L}\p{N}_.@+~%\[\]()-]+`;
const PATH = new RegExp(String.raw`^(?!~)(?:[A-Za-z]:[\\/]|/)?(?:${SEGMENT}[\\/])+${SEGMENT}$`, "u");
/** The file name's extension starts with a letter, so `1/2.5` and `v1/2.0` are not files. */
const FILE_NAME = /(?:^|[\\/])[^\\/]*\.[\p{L}_][\p{L}\p{N}_-]*$/u;
/** `:12`, `:12:5` (a column, dropped), `:12-20`, `#L12` or `#L12-L20`. */
const LOCATION = /(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$/;

/** A `LOCATION` match as the link's anchor: `#L12` or `#L12-L20`. */
function lineAnchor(location: RegExpExecArray): string {
  const line = location[1] ?? location[3];
  const endLine = location[2] ?? location[4];
  return endLine ? `#L${line}-L${endLine}` : `#L${line}`;
}

/** The link a path in inline code stands for, its line kept as `#L12`, or null when the code is not a path. */
export function codePathHref(code: string): string | null {
  const text = code.trim();
  if (!text || text.length > 1024) return null;
  const location = LOCATION.exec(text);
  const path = location ? text.slice(0, location.index) : text;
  if (!PATH.test(path) || !FILE_NAME.test(path)) return null;
  // Links decode their path, so each segment is encoded to keep names like `a:b.ts` or `100%.md` whole.
  return path.split("/").map(encodeURIComponent).join("/") + (location ? lineAnchor(location) : "");
}

type HastNode = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const textOf = (node: HastNode): string => (node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join(""));

/** Rehype step: inline code that names a file becomes a link to it. Code blocks and code already in a link are left as they are. */
export function codePathLinks() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.tagName === "pre" || node.tagName === "a" || !node.children) return;
      node.children = node.children.map((child) => {
        if (child.tagName !== "code") {
          visit(child);
          return child;
        }
        const href = codePathHref(textOf(child));
        return href ? { type: "element", tagName: "a", properties: { href }, children: [child] } : child;
      });
    };
    visit(tree);
  };
}
