/** A reply as the Markdown around its images and the images that name a file, in order. */
export type ReplySegment = { kind: "text"; text: string } | { kind: "image"; path: string; alt: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** `![alt](path)`, `![alt](<path with spaces>)` and either with a "title". */
const IMAGE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
/** An image the phone can load itself; anything else is a file on the Mac. */
const WEB = /^(?:https?:|data:)/i;

/** One line as its words and the images of files in it, in order. */
function lineParts(line: string): (string | { path: string; alt: string })[] {
  const parts: (string | { path: string; alt: string })[] = [];
  let rest = 0;
  for (const match of line.matchAll(IMAGE)) {
    const path = (match[2] ?? match[3] ?? "").trim();
    if (!path || WEB.test(path)) continue;
    parts.push(line.slice(rest, match.index), { path, alt: match[1]!.trim() });
    rest = match.index + match[0].length;
  }
  parts.push(line.slice(rest));
  // A line that only held images leaves blank words around them, which are not a line of the reply.
  return parts.length === 1 ? parts : parts.filter((part) => typeof part !== "string" || part.trim());
}

/** Whether `line` closes the fence `open`, or opens one; the fence that is open after it. */
function fenceAfter(line: string, open: string | null): string | null {
  const marker = FENCE.exec(line)?.[1];
  if (!marker) return open;
  if (!open) return marker;
  return marker[0] === open[0] && marker.length >= open.length && line.trim() === marker ? null : open;
}

/**
 * Splits a reply where it shows an image of a file, which the native Markdown view cannot reach: the file is on the
 * Mac. Web images and anything inside a code fence stay in the Markdown.
 */
export function replySegments(text: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  let words: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const joined = words.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined.trim()) segments.push({ kind: "text", text: joined });
    words = [];
  };
  for (const line of text.split("\n")) {
    const inCode = fence !== null || FENCE.test(line);
    fence = fenceAfter(line, fence);
    if (inCode) {
      words.push(line);
      continue;
    }
    for (const part of lineParts(line)) {
      if (typeof part === "string") words.push(part);
      else {
        flush();
        segments.push({ kind: "image", ...part });
      }
    }
  }
  flush();
  return segments;
}
