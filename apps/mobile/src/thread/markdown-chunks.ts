/** Roughly how much Markdown one native view takes before the next starts: a few paragraphs, a code block. */
const CHUNK_CHARS = 1000;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s/;
/** A list item that has streamed in only as far as its marker, such as "-", "1" or "12.". */
const BARE_MARKER = /^\s{0,3}([-*+]|\d+[.)]?)$/;

/**
 * A reply's top-level Markdown blocks: runs of lines between blank lines, with a fenced code block (blank lines and
 * all) as one block, and an unclosed fence running to the end.
 */
function blocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length) out.push(current.join("\n"));
    current = [];
  };
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      current.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (marker) fence = marker;
    if (!line.trim() && !fence) flush();
    else current.push(line);
  }
  flush();
  return out;
}

/**
 * A long reply as pieces, each drawn by its own native Markdown view, so the list mounts and lays out one piece at a
 * time instead of the whole reply in one frame, and a streamed word re-renders only the last piece. Pieces end only
 * between top-level blocks; a piece takes the next block while it is under the size, so text streaming into the last
 * block never moves an earlier boundary.
 */
export function markdownChunks(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  // A list runs on through its indented continuations; its next item stays with it.
  let inList = false;
  for (const block of blocks(text)) {
    const indented = /^\s/.test(block);
    const item: boolean = LIST_ITEM.test(block) || (inList && BARE_MARKER.test(block));
    const continues = indented || (item && inList);
    inList = item || (indented && inList);
    if (current.length && length >= size && !continues) {
      chunks.push(current.join("\n\n"));
      current = [];
      length = 0;
    }
    current.push(block);
    length += block.length;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return chunks.length ? chunks : [""];
}

/** A message's pieces, worked out once per version of the message: the store replaces a block whenever it changes. */
const pieces = new WeakMap<object, string[]>();
export function messagePieces(message: { text: string }): string[] {
  let chunks = pieces.get(message);
  if (!chunks) {
    chunks = markdownChunks(message.text);
    pieces.set(message, chunks);
  }
  return chunks;
}
