export type Segment = { kind: "same" | "ins" | "del"; text: string };
export type DiffBlock = { key: string; text: string };
export type BlockOp =
  { kind: "same"; base: number; next: number } | { kind: "added"; next: number } | { kind: "changed"; base: number; next: number; segments: Segment[] } | { kind: "removed"; base: number };

type Step = { kind: "same"; a: number; b: number } | { kind: "del"; a: number } | { kind: "ins"; b: number };

/** Past this many comparisons a diff gives up on alignment and replaces the whole run, which is still correct. */
const MAX_CELLS = 250_000;
/** Below this share of words in common, a removed and an added block read as two different blocks. */
const SIMILAR = 0.5;

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const tokens = (text: string) => text.match(TOKEN) ?? [];
const words = (list: string[]) => list.filter((token) => token.trim());

/** Longest common subsequence, removals before additions where a run differs. */
function align<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): Step[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return [...a.map((_, i): Step => ({ kind: "del", a: i })), ...b.map((_, j): Step => ({ kind: "ins", b: j }))];
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = same(a[i]!, b[j]!) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i]!, b[j]!)) steps.push({ kind: "same", a: i++, b: j++ });
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) steps.push({ kind: "del", a: i++ });
    else steps.push({ kind: "ins", b: j++ });
  }
  while (i < n) steps.push({ kind: "del", a: i++ });
  while (j < m) steps.push({ kind: "ins", b: j++ });
  return steps;
}

/**
 * A space or a single character left in common between two changes is folded into them, so "an app restart" →
 * "quitting and reopening OpenOrc" reads as one replacement, not five.
 */
export function wordDiff(before: string, after: string): Segment[] {
  const a = tokens(before);
  const b = tokens(after);
  const raw = align(a, b, (x, y) => x === y).map((step): Segment => (step.kind === "ins" ? { kind: "ins", text: b[step.b]! } : { kind: step.kind, text: a[step.a]! }));
  const out: Segment[] = [];
  let del = "";
  let ins = "";
  const flush = () => {
    if (del) out.push({ kind: "del", text: del });
    if (ins) out.push({ kind: "ins", text: ins });
    del = ins = "";
  };
  for (let k = 0; k < raw.length; k++) {
    const segment = raw[k]!;
    const between = Boolean(del || ins) && raw[k + 1] !== undefined && raw[k + 1]!.kind !== "same";
    const trivial = segment.kind === "same" && segment.text.trim().length <= 1 && between;
    if (segment.kind === "del") del += segment.text;
    else if (segment.kind === "ins") ins += segment.text;
    else if (trivial) {
      del += segment.text;
      ins += segment.text;
    } else {
      flush();
      const last = out.at(-1);
      if (last?.kind === "same") last.text += segment.text;
      else out.push({ kind: "same", text: segment.text });
    }
  }
  flush();
  return out;
}

export function similarity(before: string, after: string): number {
  const a = words(tokens(before));
  const b = words(tokens(after));
  if (!a.length && !b.length) return 1;
  const common = align(a, b, (x, y) => x === y).filter((step) => step.kind === "same").length;
  return (2 * common) / (a.length + b.length);
}

/**
 * Blocks that differ in the same place pair up as changed when they share enough words; the rest are added or removed,
 * removed ones before what replaced them.
 */
export function alignBlocks(base: readonly DiffBlock[], next: readonly DiffBlock[]): BlockOp[] {
  const steps = align(base, next, (x, y) => x.key === y.key);
  const ops: BlockOp[] = [];
  let removed: number[] = [];
  let added: number[] = [];
  const flush = () => {
    const unpaired = new Set(removed);
    const paired: BlockOp[] = added.map((b) => {
      const a = removed.find((candidate) => unpaired.has(candidate) && similarity(base[candidate]!.text, next[b]!.text) >= SIMILAR);
      if (a === undefined) return { kind: "added", next: b };
      unpaired.delete(a);
      return { kind: "changed", base: a, next: b, segments: wordDiff(base[a]!.text, next[b]!.text) };
    });
    ops.push(...[...unpaired].map((a): BlockOp => ({ kind: "removed", base: a })), ...paired);
    removed = [];
    added = [];
  };
  for (const step of steps) {
    if (step.kind === "del") removed.push(step.a);
    else if (step.kind === "ins") added.push(step.b);
    else {
      flush();
      ops.push({ kind: "same", base: step.a, next: step.b });
    }
  }
  flush();
  return ops;
}
