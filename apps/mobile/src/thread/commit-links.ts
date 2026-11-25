import { COMMIT_ID } from "@openorc/protocol";

/** Inline code that could be a commit's id: one backtick each side, not already a link's words. */
const CODE_ID = /(?<![`[\\])`([0-9a-f]{7,40})`(?!`)/g;
const FENCE = /^\s*(```|~~~)/;
const COMMIT_URL = /^commit:([0-9a-f]{40})$/;
/** How the Markdown styles a commit's link. */
export const COMMIT_LINKS = "^commit:";

/** Each line outside a fenced code block through `write`; the lines inside one as they are. */
function outsideFences(text: string, write: (line: string) => string): string {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const mark = FENCE.exec(line)?.[1];
      if (mark && fence === null) fence = mark;
      else if (mark === fence) fence = null;
      else if (fence === null) return write(line);
      return line;
    })
    .join("\n");
}

/** The ids a reply writes as inline code, each once, in the order it writes them. */
export function commitIds(text: string): string[] {
  const ids = new Set<string>();
  outsideFences(text, (line) => {
    for (const [, id] of line.matchAll(CODE_ID)) if (id && COMMIT_ID.test(id)) ids.add(id);
    return line;
  });
  return [...ids];
}

/** The reply with each id that names a commit written as a link to it: `named` holds the whole id each one names. */
export function withCommitLinks(text: string, named: ReadonlyMap<string, string>): string {
  if (!named.size) return text;
  return outsideFences(text, (line) =>
    line.replace(CODE_ID, (code, id: string) => {
      const sha = named.get(id);
      return sha ? `[${code}](commit:${sha})` : code;
    }),
  );
}

/** The commit a pressed link names, or null for any other link. */
export const commitAt = (url: string): string | null => COMMIT_URL.exec(url)?.[1] ?? null;
