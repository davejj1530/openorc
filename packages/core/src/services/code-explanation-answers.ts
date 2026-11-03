import { z } from "zod";
import { diagramNodeKinds, type CodeExplanation, type DiagramNodeKind, type ExplanationView, type LineSpan } from "@openorc/protocol";

/** In place of an agent's own instructions: the whole input is in the prompt, and only JSON comes back. */
export const EXPLAINER = "You explain source code. You have no tools: everything you need is in the message. Answer with only the JSON the message asks for.";

const READER = `You explain source code to an engineer who is new to this codebase, a junior included. Use plain words and short sentences. Name real identifiers in backticks. Describe only what the code shows; say so when something happens outside this file. No filler, no praise, no marketing tone, no em dashes.`;

const ASKS: Record<ExplanationView, string> = {
  english: `Explain this file in plain English as Markdown. Give it no title: the reader already sees the file's name. Open with two or three sentences on what the file is for and when it runs. Then give short sections with ## headings for its main parts, in the order a reader meets them. Say what each part does and why, not how the syntax works. Mention inputs, outputs and side effects such as network, disk or shared state. Stay under 600 words.
Return ONLY minified JSON, no code fences: {"markdown":string}`,
  walkthrough: `Split the file into consecutive blocks a reader would study one at a time: the imports, a type, a function, a component, a group of related constants. Go from the top of the file to the bottom without overlapping. Aim for 3 to 25 blocks. For each block give:
- start and end: its first and last line numbers, as printed before each line.
- title: a few words naming what the block is, like "Cart total calculation".
- explanation: Markdown, one to four sentences, like friendly technical documentation: what it does, why it exists, and anything surprising.
- symbols: the names this block defines that other files could use, such as exported functions, classes, components, types or constants. Empty when it defines none.
Also give overview: two sentences on the file as a whole.
Return ONLY minified JSON, no code fences: {"overview":string,"blocks":[{"start":number,"end":number,"title":string,"explanation":string,"symbols":[string]}]}`,
  diagram: `Draw this file's high-level logic as a flowchart a newcomer can follow: how control and data move from where the code is entered to what it produces. Use 4 to 16 nodes. Group small steps into one node; never draw one node per line. Keep it readable from top to bottom: when many parallel actions lead to the same place, make them one node, so that no more than four nodes sit side by side.
Each node has: id (short and unique: lowercase letters, digits and dashes); label (2 to 5 words); kind, one of entry (where execution starts: an exported function, an event handler, a component's render), step (work the code does), decision (a branch or a check), data (state, a cache or a stored value), external (a call outside this file: an API, the file system, another module), output (what the code returns, renders or emits); summary (one sentence); detail (Markdown, two to five sentences: what happens here, which identifiers do it, and what can go wrong); start and end (the lines that implement it, or null when it lives outside this file).
Edges connect nodes in the direction things flow, each with a label of one to three words such as "yes", "on error" or "for each item", or null.
Also give summary: one sentence on the whole flow.
Return ONLY minified JSON, no code fences: {"summary":string,"nodes":[{"id":string,"label":string,"kind":string,"summary":string,"detail":string,"start":number|null,"end":number|null}],"edges":[{"from":string,"to":string,"label":string|null}]}`,
};

/** The file as the model reads it: every line behind its number, so it can cite lines it never has to count. */
export function explanationPrompt(view: ExplanationView, path: string, text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const width = String(lines.length).length;
  const numbered = lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join("\n");
  return [READER, "", ASKS[view], "", `File: ${path}`, `It has ${lines.length} lines:`, numbered].join("\n");
}

const text = { type: "string" } as const;
const lineOrNull = { type: ["integer", "null"] } as const;
const strict = (properties: Record<string, object>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** Codex holds its reply to these. They mirror the JSON each prompt asks for. */
export const answerSchemas: Record<ExplanationView, object> = {
  english: strict({ markdown: text }),
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

const line = z.number().finite().nullable().optional();
const words = (max: number) => z.string().trim().max(max).catch("");
const answers = {
  english: z.object({ markdown: z.string().trim().min(1).max(40_000) }),
  walkthrough: z.object({
    overview: words(2_000),
    blocks: z
      .array(z.object({ start: z.number().finite(), end: z.number().finite(), title: z.string().trim().min(1).max(200), explanation: words(8_000), symbols: z.array(z.string()).catch([]) }))
      .min(1),
  }),
  diagram: z.object({
    summary: words(1_000),
    nodes: z
      .array(
        z.object({ id: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(120), kind: z.string().catch("step"), summary: words(600), detail: words(8_000), start: line, end: line }),
      )
      .min(1),
    edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().trim().max(80).nullable().optional() })).catch([]),
  }),
};

const MAX = { blocks: 60, symbols: 4, nodes: 30, edges: 60 };
const identifier = /^[A-Za-z_$][\w$]{2,}$/;

function span(start: number | null | undefined, end: number | null | undefined, count: number): LineSpan | null {
  if (start == null) return null;
  const first = Math.min(count, Math.max(1, Math.round(start)));
  return { start: first, end: Math.min(count, Math.max(first, Math.round(end ?? start))) };
}

/** Blocks in file order with no line in two of them: a block starting inside the one before starts after it, or goes. */
function walkthrough(answer: z.infer<typeof answers.walkthrough>, count: number): CodeExplanation {
  let reached = 0;
  const blocks = [];
  for (const block of [...answer.blocks].sort((a, b) => a.start - b.start)) {
    const lines = span(Math.max(block.start, reached + 1), block.end, count);
    if (!lines || lines.start <= reached || block.end < lines.start) continue;
    reached = lines.end;
    const symbols = [...new Set(block.symbols.map((name) => name.trim()).filter((name) => identifier.test(name)))].slice(0, MAX.symbols);
    blocks.push({ lines, title: block.title, explanation: block.explanation, symbols, usedBy: [] });
  }
  return { view: "walkthrough", overview: answer.overview, blocks: blocks.slice(0, MAX.blocks) };
}

function diagram(answer: z.infer<typeof answers.diagram>, count: number): CodeExplanation {
  const nodes = new Map<string, Extract<CodeExplanation, { view: "diagram" }>["nodes"][number]>();
  for (const node of answer.nodes) {
    if (nodes.has(node.id) || nodes.size >= MAX.nodes) continue;
    const kind = (diagramNodeKinds as readonly string[]).includes(node.kind) ? (node.kind as DiagramNodeKind) : "step";
    nodes.set(node.id, { id: node.id, label: node.label, kind, summary: node.summary, detail: node.detail, lines: span(node.start, node.end, count) });
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

/** A model's reply as an explanation of a file of `lines` lines, with every cited line inside it. Null when it isn't one. */
export function parseAnswer(view: ExplanationView, raw: string, lines: number): CodeExplanation | null {
  const value = json(raw);
  if (view === "english") {
    const parsed = answers.english.safeParse(value);
    return parsed.success ? { view, markdown: parsed.data.markdown } : null;
  }
  if (view === "walkthrough") {
    const parsed = answers.walkthrough.safeParse(value);
    const explained = parsed.success ? walkthrough(parsed.data, lines) : null;
    return explained?.view === "walkthrough" && explained.blocks.length ? explained : null;
  }
  const parsed = answers.diagram.safeParse(value);
  return parsed.success ? diagram(parsed.data, lines) : null;
}
