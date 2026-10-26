import { PREVIEW_TEXT_CHARS, type PreviewInput } from "@openorc/protocol";

/** Characters as a person and the Mac's Backspace count them: whole emoji and accented letters where Intl knows them. */
function characters(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
  return Array.from(text);
}

/** A line in pieces of at most 1,000 characters, never between the two halves of an emoji. */
function pieces(line: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < line.length;) {
    let end = Math.min(line.length, at + PREVIEW_TEXT_CHARS);
    const high = line.charCodeAt(end - 1);
    if (end < line.length && high >= 0xd800 && high <= 0xdbff) end--;
    out.push(line.slice(at, end));
    at = end;
  }
  return out;
}

/** Text as the Mac takes it, each line break an Enter. */
function typed(text: string): PreviewInput[] {
  return text
    .split("\n")
    .flatMap((line, index): PreviewInput[] => [...(index > 0 ? [{ kind: "key", key: "Enter", count: 1 } as const] : []), ...pieces(line).map((piece) => ({ kind: "text", text: piece }) as const)]);
}

/**
 * What the Mac must do so its field, typed into from the phone, reads `after` where it read `before`: Backspace over
 * what changed after the part both share, then the new text. The Mac's caret stays at the end of what the phone typed,
 * so an edit earlier in the phone's field retypes what follows it; autocorrect and paste are edits like any other.
 */
export function textEdits(before: string, after: string): PreviewInput[] {
  const was = characters(before);
  const now = characters(after);
  let shared = 0;
  while (shared < was.length && shared < now.length && was[shared] === now[shared]) shared++;
  const deleted = was.length - shared;
  const inputs: PreviewInput[] = [];
  for (let left = deleted; left > 0; left -= 100) inputs.push({ kind: "key", key: "Backspace", count: Math.min(100, left) });
  return [...inputs, ...typed(now.slice(shared).join(""))];
}
