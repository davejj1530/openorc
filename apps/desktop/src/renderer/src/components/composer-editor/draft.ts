import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type ParagraphNode,
  type PointType,
} from "lexical";
import { samePiece, type Piece } from "../../lib/message-marks";
import { $createMarkNode, $isMarkNode } from "./nodes";

/**
 * The draft is one paragraph of words, line breaks and marks, and every position in it is an offset into the message
 * it makes. These are the two ways across: `$readDraft` gives the message and where the caret is in it, and
 * `$writeDraft` makes the draft say a message, changing only the stretch that differs. Which words are marks is decided
 * by `$markDraft`, from the message alone.
 */

/** A stretch of the draft as its nodes hold it. */
type Unit = { kind: "words"; text: string } | { kind: "break" } | { kind: "mark"; piece: Piece };

function size(unit: Unit): number {
  if (unit.kind === "break") return 1;
  return unit.kind === "words" ? unit.text.length : unit.piece.text.length;
}

function sameUnit(a: Unit, b: Unit): boolean {
  if (a.kind === "words" && b.kind === "words") return a.text === b.text;
  if (a.kind === "mark" && b.kind === "mark") return samePiece(a.piece, b.piece);
  return a.kind === "break" && b.kind === "break";
}

/** The units a run of pieces is drawn as: words split at each line, neighbouring words joined. */
export function unitsOf(pieces: readonly Piece[]): Unit[] {
  const units: Unit[] = [];
  const words = (text: string) =>
    text.split("\n").forEach((line, index) => {
      if (index > 0) units.push({ kind: "break" });
      const last = units.at(-1);
      if (!line) return;
      if (last?.kind === "words") last.text += line;
      else units.push({ kind: "words", text: line });
    });
  for (const piece of pieces) {
    if (piece.mark) units.push({ kind: "mark", piece });
    else words(piece.text);
  }
  return units;
}

/** The units the paragraph holds, each with the nodes it is drawn from. Empty words are left out. */
function $held(paragraph: ParagraphNode): { unit: Unit; nodes: LexicalNode[] }[] {
  const held: { unit: Unit; nodes: LexicalNode[] }[] = [];
  for (const node of paragraph.getChildren()) {
    const last = held.at(-1);
    if ($isMarkNode(node)) held.push({ unit: { kind: "mark", piece: node.piece() }, nodes: [node] });
    else if ($isLineBreakNode(node)) held.push({ unit: { kind: "break" }, nodes: [node] });
    else if (last?.unit.kind === "words") {
      last.unit.text += node.getTextContent();
      last.nodes.push(node);
    } else held.push({ unit: { kind: "words", text: node.getTextContent() }, nodes: [node] });
  }
  return held.filter(({ unit }) => unit.kind !== "words" || unit.text !== "");
}

/** The draft's one paragraph, made when the draft has none. */
export function $paragraph(): ParagraphNode {
  const first = $getRoot().getFirstChild();
  if ($isParagraphNode(first)) return first;
  const paragraph = $createParagraphNode();
  $getRoot().append(paragraph);
  return paragraph;
}

/** Where a selection point falls in the message, or null where it is outside the paragraph. */
function $offsetOf(paragraph: ParagraphNode, point: PointType): number | null {
  const node = point.getNode();
  const before = (children: LexicalNode[]) => children.reduce((sum, child) => sum + child.getTextContentSize(), 0);
  if (node.is(paragraph)) return before(paragraph.getChildren().slice(0, point.offset));
  if (node.is($getRoot())) return point.offset === 0 ? 0 : paragraph.getTextContentSize();
  if (!node.getParent()?.is(paragraph)) return null;
  return (point.type === "text" ? point.offset : 0) + before(node.getPreviousSiblings());
}

/** The selection point at `offset` in the message. One that would fall inside a mark lands after it. */
function $pointAt(paragraph: ParagraphNode, offset: number): { key: string; offset: number; type: "text" | "element" } {
  const children = paragraph.getChildren();
  let at = 0;
  for (const [index, child] of children.entries()) {
    const length = child.getTextContentSize();
    if ($isTextNode(child) && offset <= at + length) return { key: child.getKey(), offset: offset - at, type: "text" };
    if (!$isTextNode(child) && offset < at + length) return { key: paragraph.getKey(), offset: offset <= at ? index : index + 1, type: "element" };
    at += length;
  }
  return { key: paragraph.getKey(), offset: children.length, type: "element" };
}

/** The selection's ends as offsets in the message, or null when there is no selection in the draft. */
export function $selectionSpan(): { anchor: number; focus: number } | null {
  const selection = $getSelection();
  const paragraph = $getRoot().getFirstChild();
  if (!$isRangeSelection(selection) || !$isParagraphNode(paragraph)) return null;
  const anchor = $offsetOf(paragraph, selection.anchor);
  const focus = $offsetOf(paragraph, selection.focus);
  return anchor === null || focus === null ? null : { anchor, focus };
}

function $select(anchor: number, focus = anchor): void {
  const paragraph = $paragraph();
  const selection = $createRangeSelection();
  const from = $pointAt(paragraph, anchor);
  const to = $pointAt(paragraph, focus);
  selection.anchor.set(from.key, from.offset, from.type);
  selection.focus.set(to.key, to.offset, to.type);
  $setSelection(selection);
}

/** The message the draft makes, and where the caret is in it (null while the draft has no selection). */
export function $readDraft(): { text: string; caret: number | null } {
  const span = $selectionSpan();
  return { text: $getRoot().getTextContent(), caret: span ? Math.min(span.anchor, span.focus) : null };
}

/** Makes the draft say `next` with the caret at `caret`, changing only the stretch that differs, widened over any mark it cuts. */
export function $writeDraft(next: string, caret = next.length): void {
  const paragraph = $paragraph();
  const now = paragraph.getTextContent();
  const most = Math.min(now.length, next.length);
  let start = 0;
  while (start < most && now[start] === next[start]) start++;
  let end = 0;
  while (end < most - start && now[now.length - 1 - end] === next[next.length - 1 - end]) end++;
  let from = start;
  let to = now.length - end;
  let at = 0;
  for (const child of paragraph.getChildren()) {
    const length = child.getTextContentSize();
    if ($isMarkNode(child)) {
      if (at < from && from < at + length) from = at;
      if (at < to && to < at + length) to = at + length;
    }
    at += length;
  }
  const insert = next.slice(from, next.length - (now.length - to));
  if (from !== to || insert) {
    $select(from, to);
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      if (insert) selection.insertRawText(insert);
      else selection.removeText();
    }
  }
  $select(caret);
}

/**
 * Leaves as words a mark that ends at the caret and is not already a mark there, so a name typed in full lands only
 * once the caret moves on: Backspace then takes back the last letter typed, not the whole name.
 */
export function holdAtCaret(pieces: readonly Piece[], caret: number | null, held: readonly Unit[]): Piece[] {
  if (caret === null) return [...pieces];
  const kept = new Set<string>();
  let offset = 0;
  for (const unit of held) {
    if (unit.kind === "mark") kept.add(`${offset}:${JSON.stringify(unit.piece)}`);
    offset += size(unit);
  }
  let at = 0;
  return pieces.map((piece) => {
    const start = at;
    at += piece.text.length;
    return piece.mark && at === caret && !kept.has(`${start}:${JSON.stringify(piece)}`) ? { text: piece.text } : piece;
  });
}

/** How many units at the start, and then at the end, two runs share. */
function sharedEnds(held: readonly Unit[], wanted: readonly Unit[]): { same: number; tail: number } {
  let same = 0;
  while (same < held.length && same < wanted.length && sameUnit(held[same]!, wanted[same]!)) same++;
  let tail = 0;
  while (tail < held.length - same && tail < wanted.length - same && sameUnit(held[held.length - 1 - tail]!, wanted[wanted.length - 1 - tail]!)) tail++;
  return { same, tail };
}

/**
 * Draws the paragraph as `read` reads its message, changing only the run of units that differs, so marks that stay
 * keep their nodes, and puts the selection back where it was in the message. With `defer`, a new mark at the caret
 * waits (see holdAtCaret). Answers whether anything changed.
 */
export function $markDraft(read: (text: string) => Piece[], defer: boolean): boolean {
  const paragraph = $paragraph();
  const held = $held(paragraph);
  const span = $selectionSpan();
  const caret = defer && span && span.anchor === span.focus ? span.anchor : null;
  const wanted = unitsOf(
    holdAtCaret(
      read(paragraph.getTextContent()),
      caret,
      held.map(({ unit }) => unit),
    ),
  );
  const { same, tail } = sharedEnds(
    held.map(({ unit }) => unit),
    wanted,
  );
  if (same === held.length && same === wanted.length) return false;
  const made = wanted.slice(same, wanted.length - tail).map((unit) => {
    if (unit.kind === "words") return $createTextNode(unit.text);
    if (unit.kind === "break") return $createLineBreakNode();
    return $createMarkNode(unit.piece.text, unit.piece.mark!);
  });
  const next = held[held.length - tail]?.nodes[0];
  for (const node of made) {
    if (next) next.insertBefore(node);
    else paragraph.append(node);
  }
  for (const { nodes } of held.slice(same, held.length - tail)) for (const node of nodes) node.remove();
  if (span) $select(span.anchor, span.focus);
  return true;
}
