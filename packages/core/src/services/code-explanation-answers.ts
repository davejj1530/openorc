import { z } from "zod";
import { diagramNodeKinds, type CodeExplanation, type DiagramNodeKind, type ExplanationView, type LineNote, type LineSpan } from "@openorc/protocol";

/** In place of an agent's own instructions: the whole input is in the prompt, and only JSON comes back. */
export const EXPLAINER = "You explain source code. You have no tools: everything you need is in the message. Answer with only the JSON the message asks for.";

const READER = `You explain code to someone who has never written any, such as a curious twelve-year-old. Use everyday words and short sentences. The first time a programming idea comes up, such as a type, a function, an import or a store, say what it is in a few plain words, like "a type is a rule for what shape some data must have" or "a function is a set of steps you can run by name". Say what the code is doing and why, not how its symbols are spelled. Never use programmer words such as spread, clamp, toggle, instantiate, render, mutate, payload, callback, field or boolean: say what happens instead, like "keeps the width between its smallest and largest size" for a clamp. Name the code's own things in backticks, then say what they are. Describe only what the code shows; when something happens in another file, say so. No filler, no praise, no em dashes.`;

/** The examples are made up on purpose: one taken from real code gets copied onto the matching line of a real file. */
const NOTE = `Each note is one or two short sentences that start with what happens, never with a label such as "Import:". These made-up examples show the grouping and the level to aim for; they are not from this file.
- A whole import list is one note, on its first line. For \`import {\` / \`  packLunch,\` / \`  pourJuice,\` / \`} from './kitchen';\` a good note is: "Borrows two helpers from the kitchen file: \`packLunch\` makes a lunch and \`pourJuice\` fills a cup."
- One statement is one note. For \`const lunchBox = packLunch(sandwich, apple);\` a good note is: "Packs a sandwich and an apple together in \`lunchBox\`, so later steps can hand out lunch."
- Neighbouring lines about the same thing share a note. For \`isHungry: boolean;\` followed by \`mealsToday: number;\` inside a type, a good note on the first of them is: "Remembers whether someone is hungry, and how many meals they have had today."`;

const asks: Record<ExplanationView, (range: LineSpan) => string> = {
  english: ({
    start,
    end,
  }) => `Explain lines ${start} to ${end} statement by statement, in order, the way a patient teacher reads code aloud to someone who has never programmed. The rest of the file is there so you understand these lines: say nothing about it.
Give one note for each thing the code does. Usually that is one statement: a single line, or a statement that runs over several lines, such as an import list, a long call or a small object, which gets one note for all of it. A few neighbouring lines that describe the same thing share a note. Never explain a piece of a statement on its own, such as one name in an import list or one argument of a call. Never let one note cover a whole function, type or long object either: go inside it and explain what happens there, a statement or a small group at a time. Skip blank lines, lines that only close brackets or tags, and comments whose words the code already says.
Give each note the number of the first line it covers, as printed before it, that line's code copied exactly, up to 40 characters, and the number of the last line it covers. ${NOTE}
Return ONLY minified JSON, no code fences: {"notes":[{"line":number,"end":number,"code":string,"text":string}]}`,
  walkthrough: ({
    start,
    end,
  }) => `The rest of the file is there so you understand lines ${start} to ${end}: say nothing about it. Split lines ${start} to ${end} into consecutive blocks a reader would study one at a time: the imports, a type, a function, a component, a group of related constants. Go from top to bottom without overlapping, about one block for every 5 to 40 lines. For each block give:
- start and end: its first and last line numbers, as printed before each line.
- title: a few everyday words naming what the block is, like "Adding up the cart".
- explanation: Markdown, two to four sentences: what the block is for, why the file needs it, and how it fits with the rest.
- symbols: the names this block defines that other files could use, such as exported functions, classes, components, types or constants. Empty when it defines none.
${start === 1 ? "Also give overview: two or three sentences on what the whole file is for." : "Give overview as an empty string: another part of the file has it."}
Return ONLY minified JSON, no code fences: {"overview":string,"blocks":[{"start":number,"end":number,"title":string,"explanation":string,"symbols":[string]}]}`,
  diagram:
    () => `Draw this file's logic as a flowchart a newcomer can follow: how things move from where the code starts to what it produces. Use 4 to 16 nodes. Group small steps into one node; never draw one node per line. Keep it readable from top to bottom: when many parallel actions lead to the same place, make them one node, so that no more than four nodes sit side by side.
Each node has: id (short and unique: lowercase letters, digits and dashes); label (2 to 5 everyday words); kind, one of entry (where things start: an exported function, an event handler, a screen being drawn), step (work the code does), decision (a choice or a check), data (something remembered: state, a cache, a stored value), external (something outside this file: a website, the disk, another module), output (what comes out: a returned value, a screen, a message); summary (one sentence); detail (Markdown, two to five sentences: what happens here, which of the code's names do it, and what can go wrong); start and end (the lines that do it, or null when it lives outside this file).
Edges connect nodes in the direction things flow, each with a label of one to three words such as "yes", "if it fails" or "for each item", or null.
Also give summary: one sentence on the whole flow.
Return ONLY minified JSON, no code fences: {"summary":string,"nodes":[{"id":string,"label":string,"kind":string,"summary":string,"detail":string,"start":number|null,"end":number|null}],"edges":[{"from":string,"to":string,"label":string|null}]}`,
};

const sourceLines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/** Lines that hold only brackets, punctuation or a comment's markers say nothing worth a note. */
const quiet = (line: string) =>
  /^[\s()[\]{}<>;,.]*$/.test(line) ||
  /^\s*(?:\/\/|\/\*+|\*+\/?|#)\s*$/.test(line) ||
  // A closing tag, or the end of a conditional that shows nothing: `</Tooltip>`, `) : null}`.
  /^\s*<\/[\w.:-]*>[\s;,)}\]]*$/.test(line) ||
  /^[\s)}\]]*:\s*(?:null|undefined|false)[\s;,)}\]]*$/.test(line);

/** The whole file as the model reads it, every line behind its number, and which of its lines to explain. */
export function explanationPrompt(view: ExplanationView, path: string, text: string, range?: LineSpan, again?: "split"): string {
  const lines = sourceLines(text);
  const width = String(lines.length).length;
  const numbered = lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join("\n");
  const part = range ?? { start: 1, end: lines.length };
  const ask = asks[view](part);
  return [READER, "", ask, ...(again ? ["", SPLIT(part)] : []), "", `File: ${path}`, `It has ${lines.length} lines:`, numbered].join("\n");
}

/** Asking again about one note that held too much: the same question, with why the first answer won't do. */
const SPLIT = ({ start, end }: LineSpan) =>
  `Lines ${start} to ${end} were explained before in a single note, which was too much at once for a newcomer. Split them: give several notes, each covering a few lines that belong together, so every part of these lines gets its own plain explanation.`;

/** Lines asked about in one request. Notes for a long file take minutes in one answer and seconds in parts; blocks cost a few sentences each, however long. */
const PARTS: Record<ExplanationView, number> = { english: 55, walkthrough: 300, diagram: Infinity };

/**
 * The parts a file is explained in, each asked about at once with the whole file for context. Notes cut at a blank
 * line; a walkthrough cuts only before a line that starts at the margin, so no block is split between two parts.
 */
export function explanationParts(view: ExplanationView, text: string): LineSpan[] {
  const lines = sourceLines(text);
  const count = lines.length;
  if (view === "english") return noteParts(lines);
  const part = PARTS[view];
  const cut = (line: number) => !lines[line - 1]?.trim() && /^\S/.test(lines[line] ?? "");
  const parts: LineSpan[] = [];
  let start = 1;
  while (count - start + 1 > part * 1.4) {
    const near = Array.from({ length: part }, (_, index) => start + Math.round(part * 0.6) + index).filter((line) => line < count && cut(line));
    const after = near.length ? null : Array.from({ length: count - start }, (_, index) => start + part + index).find((line) => line < count && cut(line));
    const end = near.sort((a, b) => Math.abs(a - (start + part)) - Math.abs(b - (start + part)))[0] ?? after;
    if (!end) break;
    parts.push({ start, end });
    start = end + 1;
  }
  parts.push({ start, end: count });
  return parts;
}

/** Even parts for line notes, which can end on any line: at a blank line when one is close, else right at the mark. */
function noteParts(lines: readonly string[]): LineSpan[] {
  const count = lines.length;
  const size = Math.ceil(count / Math.ceil(count / PARTS.english));
  const parts: LineSpan[] = [];
  for (let start = 1; start <= count;) {
    const mark = start + size - 1;
    if (mark >= count) {
      parts.push({ start, end: count });
      break;
    }
    const blank = Array.from({ length: 13 }, (_, index) => mark - 6 + index).find((line) => line > start && line < count && !lines[line - 1]?.trim());
    const end = blank ?? mark;
    parts.push({ start, end });
    start = end + 1;
  }
  return parts;
}

const text = { type: "string" } as const;
const lineOrNull = { type: ["integer", "null"] } as const;
const strict = (properties: Record<string, object>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** Codex holds its reply to these. They mirror the JSON each prompt asks for. */
const notes = { type: "array", items: strict({ line: { type: "integer" }, end: { type: "integer" }, code: text, text }) };
export const answerSchemas: Record<ExplanationView, object> = {
  english: strict({ notes }),
  walkthrough: strict({
    overview: text,
    blocks: { type: "array", items: strict({ start: { type: "integer" }, end: { type: "integer" }, title: text, explanation: text, symbols: { type: "array", items: text } }) },
  }),
  diagram: strict({
    summary: text,
    nodes: { type: "array", items: strict({ id: text, label: text, kind: { type: "string", enum: [...diagramNodeKinds] }, summary: text, detail: text, start: lineOrNull, end: lineOrNull }) },
    edges: { type: "array", items: strict({ from: text, to: text, label: { type: ["string", "null"] } }) },
  }),
};

/** A line number, which models sometimes write as a string. */
const lineNumber = z.union([z.number().finite(), z.string().trim().regex(/^\d+$/).transform(Number)]);
const line = lineNumber.nullable().optional();
/** The house voice has no em dashes; a model writes them anyway, so they become commas. */
const undashed = (text: string) => text.replace(/\s*\u2014\s*/g, ", ");
const said = (min: number, max: number) => z.string().trim().min(min).max(max).transform(undashed);
const words = (max: number) => said(0, max).catch("");
/** A list whose malformed items drop out one by one, so one bad item never costs the rest of the answer. */
const each = <T extends z.ZodType>(item: T) =>
  z.array(z.unknown()).transform((list) =>
    list.flatMap((value) => {
      const parsed = item.safeParse(value);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );
const note = z.object({ line: lineNumber, end: line, code: z.string().catch(""), text: words(2_000) });
const block = z.object({
  start: lineNumber,
  end: lineNumber,
  title: said(1, 200),
  explanation: words(8_000),
  symbols: z.array(z.string()).catch([]),
});
const node = z.object({
  id: z.string().trim().min(1).max(80),
  label: said(1, 120),
  kind: z.string().catch("step"),
  summary: words(600),
  detail: words(8_000),
  start: line,
  end: line,
});
const edge = z.object({ from: z.string(), to: z.string(), label: said(0, 80).nullable().optional() });
const answers = {
  english: z.object({ notes: each(note) }),
  walkthrough: z.object({ overview: words(2_000), blocks: each(block) }),
  diagram: z.object({ summary: words(1_000), nodes: each(node), edges: each(edge).catch([]) }),
};

const MAX = { blocks: 60, notes: 240, symbols: 4, nodes: 30, edges: 60 };
const identifier = /^[A-Za-z_$][\w$]{2,}$/;

function span(start: number | null | undefined, end: number | null | undefined, within: LineSpan): LineSpan | null {
  if (start == null) return null;
  const first = Math.min(within.end, Math.max(within.start, Math.round(start)));
  return { start: first, end: Math.min(within.end, Math.max(first, Math.round(end ?? start))) };
}

/** Spans in file order inside `within`, no line in two: one starting inside the one before starts after it, or goes. */
function inOrder<T extends { start: number; end: number }, R>(items: readonly T[], within: LineSpan, limit: number, make: (item: T, lines: LineSpan) => R | null): R[] {
  let reached = within.start - 1;
  const kept: R[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    if (item.start > within.end) break;
    const lines = span(Math.max(item.start, reached + 1), item.end, within);
    if (!lines || lines.start <= reached || item.end < lines.start) continue;
    const made = make(item, lines);
    if (made === null) continue;
    reached = lines.end;
    kept.push(made);
    if (kept.length === limit) break;
  }
  return kept;
}

/** Models re-space code they quote (`a(){` for `a() {`), so quotes and lines compare without any whitespace. */
const bare = (code: string) => code.replace(/\s+/g, "");
/** How far from the line it names a note may find the code it quotes. Models count lines badly and copy them well. */
const ANCHOR_REACH = 12;

/** The line a quote names: its first line, without the dots a model adds when it cuts code short, and no whitespace. */
const quoted = (code: string) => bare((code.split("\n").find((line) => line.trim()) ?? "").replace(/\s*(?:\.\.\.|\u2026)\s*$/, "")).slice(0, 30);

/** The line a note means: the one it names when its quoted code is there, else the nearest line that holds that code. */
function anchored(lines: readonly string[], line: number, code: string): number | null {
  const quote = quoted(code);
  if (!quote) return line;
  // A short line such as `import {` is held by a quote that runs on past it.
  const holds = (at: number) => {
    const source = bare(lines[at - 1] ?? "");
    return source.includes(quote) || (source.length >= 3 && quote.startsWith(source));
  };
  for (let reach = 0; reach <= ANCHOR_REACH; reach++) for (const at of [line - reach, line + reach]) if (holds(at)) return at;
  return null;
}

/**
 * A note is about the line its quote is found on and the lines that carry on after it, up to the next note, without
 * the brackets that close it. Notes outside `within`, without words, whose quote is nowhere near, or on a line already
 * noted drop out.
 */
function lineNotes(raw: readonly z.output<typeof note>[], within: LineSpan, text: string): LineNote[] {
  const lines = sourceLines(text);
  const kept = [...raw]
    .map((item) => {
      const named = Math.round(item.line);
      const line = anchored(lines, named, item.code) ?? 0;
      // A note moved to the line its quote is on keeps its length, so its last line moves with it.
      return { line, end: item.end == null ? null : Math.round(item.end) + line - named, text: item.text };
    })
    .filter(
      (item, index, all) => item.text && item.line >= within.start && item.line <= within.end && !quiet(lines[item.line - 1] ?? "") && all.findIndex((other) => other.line === item.line) === index,
    )
    .sort((a, b) => a.line - b.line)
    .slice(0, MAX.notes);
  return kept.map((item, index) => {
    const before = (kept[index + 1]?.line ?? within.end + 1) - 1;
    let end = item.end == null ? before : Math.min(before, Math.max(item.line, item.end));
    while (end > item.line && quiet(lines[end - 1] ?? "")) end--;
    return { lines: { start: item.line, end }, text: item.text };
  });
}

function walkthrough(answer: z.output<typeof answers.walkthrough>, within: LineSpan): CodeExplanation {
  const blocks = inOrder(answer.blocks, within, MAX.blocks, (block, lines) => {
    const symbols = [...new Set(block.symbols.map((name) => name.trim()).filter((name) => identifier.test(name)))].slice(0, MAX.symbols);
    return { lines, title: block.title, explanation: block.explanation, steps: [], symbols, usedBy: [] };
  });
  return { view: "walkthrough", overview: answer.overview, blocks };
}

function diagram(answer: z.output<typeof answers.diagram>, within: LineSpan): CodeExplanation {
  const nodes = new Map<string, Extract<CodeExplanation, { view: "diagram" }>["nodes"][number]>();
  for (const node of answer.nodes) {
    if (nodes.has(node.id) || nodes.size >= MAX.nodes) continue;
    const kind = (diagramNodeKinds as readonly string[]).includes(node.kind) ? (node.kind as DiagramNodeKind) : "step";
    nodes.set(node.id, { id: node.id, label: node.label, kind, summary: node.summary, detail: node.detail, lines: span(node.start, node.end, within) });
  }
  const edges = new Map<string, { from: string; to: string; label: string | null }>();
  for (const edge of answer.edges) {
    const key = `${edge.from}\n${edge.to}`;
    if (nodes.has(edge.from) && nodes.has(edge.to) && !edges.has(key) && edges.size < MAX.edges) edges.set(key, { from: edge.from, to: edge.to, label: edge.label || null });
  }
  return { view: "diagram", summary: answer.summary, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * The JSON inside a reply, past any code fence or sentence the model put around it. The outermost braces step past a
 * fence on their own, so a fenced code sample inside the explanation keeps its fences.
 */
function json(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A model's reply about the lines `within` of `text`, every cited line kept inside them. Null when it explains none of them. */
export function parseAnswer(view: ExplanationView, raw: string, within: LineSpan, text: string): CodeExplanation | null {
  const value = json(raw);
  if (view === "english") {
    const parsed = answers.english.safeParse(value);
    const notes = parsed.success ? lineNotes(parsed.data.notes, within, text) : [];
    // A part of only comments can rightly have nothing to explain; notes that all dropped out are an unusable answer.
    const nothingToSay = parsed.success && Array.isArray((value as { notes?: unknown }).notes) && !(value as { notes: unknown[] }).notes.length;
    return notes.length || nothingToSay ? { view, notes } : null;
  }
  if (view === "walkthrough") {
    const parsed = answers.walkthrough.safeParse(value);
    const explained = parsed.success ? walkthrough(parsed.data, within) : null;
    return explained?.view === "walkthrough" && explained.blocks.length ? explained : null;
  }
  const parsed = answers.diagram.safeParse(value);
  const explained = parsed.success ? diagram(parsed.data, within) : null;
  return explained?.view === "diagram" && explained.nodes.length ? explained : null;
}

/** Lines that do something past which a note is too broad: it holds several statements that deserve notes of their own. A long import list or call stays whole below it. */
const BROAD = 8;

/** A note too broad to read: more than `BROAD` lines that do something. */
export function coarseNotes(notes: readonly LineNote[], text: string): LineNote[] {
  const lines = sourceLines(text);
  return notes.filter(({ lines: { start, end } }) => Array.from({ length: end - start + 1 }, (_, index) => lines[start - 1 + index] ?? "").filter((line) => !quiet(line)).length > BROAD);
}

/** Stretches of `within` that no note covers yet hold more than one line that does something: a model skipped them. */
export function uncoveredStretches(notes: readonly LineNote[], within: LineSpan, text: string): LineSpan[] {
  const lines = sourceLines(text);
  const covered = new Set(notes.flatMap(({ lines: { start, end } }) => Array.from({ length: end - start + 1 }, (_, index) => start + index)));
  const stretches: LineSpan[] = [];
  let from: number | null = null;
  for (let line = within.start; line <= within.end + 1; line++) {
    const open = line <= within.end && !covered.has(line);
    if (open && from === null) from = line;
    if (open || from === null) continue;
    const stretch = Array.from({ length: line - from }, (_, index) => from! + index).filter((at) => !quiet(lines[at - 1] ?? ""));
    if (stretch.length > 1) stretches.push({ start: stretch[0]!, end: stretch.at(-1)! });
    from = null;
  }
  return stretches;
}

/** Each block's own lines, from the file's notes, as its steps. */
export function withSteps(walkthrough: Extract<CodeExplanation, { view: "walkthrough" }>, notes: readonly LineNote[]): Extract<CodeExplanation, { view: "walkthrough" }> {
  return {
    ...walkthrough,
    blocks: walkthrough.blocks.map((block) => ({
      ...block,
      steps: notes
        .filter((note) => note.lines.start >= block.lines.start && note.lines.start <= block.lines.end)
        .map((note) => ({ ...note, lines: { start: note.lines.start, end: Math.min(note.lines.end, block.lines.end) } })),
    })),
  };
}

/** The parts' explanations, in file order, as one. The walkthrough's overview is the first part's. */
export function joinParts(parts: readonly CodeExplanation[]): CodeExplanation | null {
  const [first] = parts;
  if (!first) return null;
  if (first.view === "english") return { view: "english", notes: parts.flatMap((part) => (part.view === "english" ? part.notes : [])) };
  if (first.view === "walkthrough") return { view: "walkthrough", overview: first.overview, blocks: parts.flatMap((part) => (part.view === "walkthrough" ? part.blocks : [])) };
  return first;
}
