import { describe, expect, it } from "vitest";
import { coarseNotes, explanationParts, explanationPrompt, joinParts, parseAnswer, uncoveredStretches, withSteps } from "./code-explanation-answers.js";

const file = (lines: number) => ({ start: 1, end: lines });

describe("the prompt", () => {
  it("numbers every line so the model can cite lines, and keeps CRLF files to the same count", () => {
    const prompt = explanationPrompt("walkthrough", "src/cart.ts", "const a = 1;\r\nconst b = 2;\r\n");
    expect(prompt).toContain("File: src/cart.ts\nIt has 2 lines:\n1| const a = 1;\n2| const b = 2;");
  });
  it("shows the whole file and asks only about the part's lines, with the overview from the part that starts it", () => {
    const text = Array.from({ length: 300 }, (_, index) => `const v${index} = ${index};`).join("\n");
    const later = explanationPrompt("walkthrough", "big.ts", text, { start: 101, end: 200 });
    expect(later).toContain("Split lines 101 to 200");
    expect(later).toContain("Give overview as an empty string");
    expect(later).toContain("300| const v299 = 299;");
    expect(explanationPrompt("walkthrough", "big.ts", text, { start: 1, end: 100 })).toContain("Also give overview");
    expect(explanationPrompt("english", "big.ts", text, { start: 1, end: 100 })).toContain("Explain lines 1 to 100 statement by statement");
  });
  it("says why when it asks again about lines one note held, and only then", () => {
    const text = Array.from({ length: 30 }, (_, index) => `const v${index} = ${index};`).join("\n");
    expect(explanationPrompt("english", "a.ts", text, { start: 4, end: 16 }, "split")).toContain("Lines 4 to 16 were explained before in a single note");
    expect(explanationPrompt("english", "a.ts", text, { start: 4, end: 16 })).not.toContain("were explained before");
  });
});

describe("how a file is split for asking", () => {
  const functions = (count: number, size: number) =>
    Array.from({ length: count }, (_, index) => [`export function f${index}() {`, ...Array.from({ length: size - 2 }, () => "  step();"), "}", ""].join("\n")).join("\n");

  it("asks about a short file, and any diagram, in one go", () => {
    const short = functions(2, 25);
    expect(explanationParts("english", short)).toEqual([file(short.split("\n").length - 1)]);
    const long = functions(20, 25);
    expect(explanationParts("diagram", long)).toEqual([file(long.split("\n").length - 1)]);
  });

  it("cuts a long walkthrough only between top-level parts, so no block straddles two requests", () => {
    const text = functions(40, 25);
    const parts = explanationParts("walkthrough", text);
    const lines = text.split("\n");
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[0]?.start).toBe(1);
    expect(parts.at(-1)?.end).toBe(lines.length - 1);
    for (const [index, part] of parts.entries()) {
      if (index > 0) expect(part.start).toBe(parts[index - 1]!.end + 1);
      if (index < parts.length - 1) expect(lines[part.end]).toMatch(/^export function/);
    }
  });

  it("keeps a function longer than a walkthrough part whole, while its line notes cut inside it", () => {
    expect(explanationParts("walkthrough", functions(1, 900))).toEqual([file(900)]);
    expect(explanationParts("walkthrough", functions(1, 900) + "\n" + functions(1, 30)).map((part) => part.end)).toEqual([901, 931]);
    const notes = explanationParts("english", functions(1, 400));
    expect(notes.length).toBe(8);
    expect(notes.map((part) => part.end - part.start + 1).every((size) => size >= 44 && size <= 56)).toBe(true);
    for (const [index, part] of notes.entries()) if (index) expect(part.start).toBe(notes[index - 1]!.end + 1);
  });
});

describe("Plain English answers", () => {
  const source = ["import { sum } from './sum';", "", "export function total(items) {", "  const all = items.filter(", "    (item) => item.price > 0,", "  );", "  return sum(all);", "}", ""].join(
    "\n",
  );
  const notes = (...items: [number, string, string][]) => JSON.stringify({ notes: items.map(([line, code, text]) => ({ line, code, text })) });

  it("gives each note its line and the lines that carry on after it, up to the next note, without closing brackets", () => {
    const parsed = parseAnswer(
      "english",
      notes([3, "export function total", "Starts a recipe."], [1, "import { sum }", "Borrows `sum`."], [4, "const all", "Keeps the priced items."], [7, "return sum(all);", "Adds them up."]),
      file(8),
      source,
    );
    expect(parsed).toEqual({
      view: "english",
      notes: [
        { lines: { start: 1, end: 1 }, text: "Borrows `sum`." },
        { lines: { start: 3, end: 3 }, text: "Starts a recipe." },
        { lines: { start: 4, end: 5 }, text: "Keeps the priced items." },
        { lines: { start: 7, end: 7 }, text: "Adds them up." },
      ],
    });
  });

  it("moves a note to the line that holds the code it quotes, and drops one whose quote is nowhere near", () => {
    const parsed = parseAnswer("english", notes([5, "return sum(all);", "Adds them up."], [1, "a line this file never had", "Lost."], [4, "", "No quote."]), file(8), source);
    expect(parsed?.view === "english" && parsed.notes.map((note) => [note.lines.start, note.text])).toEqual([
      [4, "No quote."],
      [7, "Adds them up."],
    ]);
  });

  it("reads a quote by its first line, without the dots of a shortened one, and holds a short line it runs past", () => {
    const multiline = parseAnswer("english", notes([1, "export function total(items) {\n  const all", "The recipe."]), file(8), source);
    expect(multiline).toMatchObject({ notes: [{ lines: { start: 3 } }] });
    const shortened = parseAnswer("english", notes([7, "const all = items.filter...", "Keeps the priced items."]), file(8), source);
    expect(shortened).toMatchObject({ notes: [{ lines: { start: 4 } }] });
  });

  it("covers the lines a note names when it says where it ends, moved along with its first line", () => {
    const parsed = parseAnswer("english", JSON.stringify({ notes: [{ line: 2, end: 3, code: "const all", text: "Keeps the priced items." }] }), file(8), source);
    expect(parsed).toEqual({ view: "english", notes: [{ lines: { start: 4, end: 5 }, text: "Keeps the priced items." }] });
  });

  it("drops a note on a line that only closes a tag or a bracket", () => {
    const jsx = ["return (", "  <Tooltip>", "    <Button />", "  </Tooltip>", ");"].join("\n");
    const parsed = parseAnswer("english", notes([3, "<Button />", "Shows a button."], [4, "</Tooltip>", "Finishes the hint."]), file(5), jsx);
    expect(parsed?.view === "english" && parsed.notes.map((note) => note.text)).toEqual(["Shows a button."]);
  });

  it("finds stretches no note covers that hold more than one line doing something", () => {
    const covered = [
      { lines: { start: 1, end: 1 }, text: "" },
      { lines: { start: 7, end: 7 }, text: "" },
    ];
    expect(uncoveredStretches(covered, file(8), source)).toEqual([{ start: 3, end: 5 }]);
    expect(uncoveredStretches([...covered, { lines: { start: 4, end: 5 }, text: "" }], file(8), source)).toEqual([]);
  });

  it("keeps only notes inside the part asked about, one per line", () => {
    const parsed = parseAnswer("english", notes([1, "import", "Before it."], [4, "const all", "First."], [4, "const all", "Again."], [7, "return", "Past it."]), { start: 3, end: 5 }, source);
    expect(parsed).toEqual({ view: "english", notes: [{ lines: { start: 4, end: 5 }, text: "First." }] });
  });

  it("keeps a code sample's fences inside a note while stepping past the fence around the reply", () => {
    const text = "It runs:\n\n```ts\nsum(all);\n```";
    expect(parseAnswer("english", `\`\`\`json\n${notes([7, "return", text])}\n\`\`\``, file(8), source)).toEqual({ view: "english", notes: [{ lines: { start: 7, end: 7 }, text }] });
  });

  it("writes an em dash the model used as a comma", () => {
    expect(parseAnswer("english", notes([7, "return", "Adds them up\u2014every one."]), file(8), source)).toMatchObject({ notes: [{ text: "Adds them up, every one." }] });
  });

  it("matches a quote however the model spaced it", () => {
    expect(parseAnswer("english", notes([1, "export  function total(items){", "Starts a recipe."]), file(8), source)).toMatchObject({ notes: [{ lines: { start: 3 } }] });
  });

  it("takes an honest empty answer as nothing to explain, but refuses notes that all dropped out", () => {
    expect(parseAnswer("english", JSON.stringify({ notes: [] }), file(8), source)).toEqual({ view: "english", notes: [] });
    expect(parseAnswer("english", notes([1, "nowhere in this file", "Lost."]), file(8), source)).toBeNull();
  });

  it("refuses a reply with no notes in it", () => {
    expect(parseAnswer("english", "I can't help with that.", file(8), source)).toBeNull();
    expect(parseAnswer("english", notes([1, "import", "   "]), file(8), source)).toBeNull();
  });
});

describe("walkthrough answers", () => {
  const block = (start: number, end: number, title: string, symbols: string[] = []) => ({ start, end, title, explanation: `${title} explained`, symbols });
  const parse = (blocks: unknown[], lines = 40) => parseAnswer("walkthrough", JSON.stringify({ overview: "A cart.", blocks }), file(lines), "");

  it("puts blocks in file order, never shares a line between two, and keeps every cited line inside the file", () => {
    const parsed = parse([block(20, 60, "Total"), block(1, 5, "Imports"), block(4, 12, "Types"), block(8, 10, "Swallowed")], 40);
    expect(parsed).toMatchObject({
      view: "walkthrough",
      overview: "A cart.",
      blocks: [
        { lines: { start: 1, end: 5 }, title: "Imports" },
        { lines: { start: 6, end: 12 }, title: "Types" },
        { lines: { start: 20, end: 40 }, title: "Total" },
      ],
    });
  });

  it("gives each block the file's line notes that start inside it as its steps", () => {
    const parsed = parse([block(1, 2, "Imports"), block(3, 8, "Total")]);
    const notes = [
      { lines: { start: 1, end: 1 }, text: "Brings in a helper." },
      { lines: { start: 3, end: 4 }, text: "Starts at zero." },
      { lines: { start: 7, end: 9 }, text: "Hands it back." },
      { lines: { start: 12, end: 12 }, text: "After every block." },
    ];
    const stepped = parsed?.view === "walkthrough" ? withSteps(parsed, notes) : null;
    expect(stepped?.blocks.map((kept) => kept.steps)).toEqual([[notes[0]], [notes[1], { lines: { start: 7, end: 8 }, text: "Hands it back." }]]);
  });

  it("calls a note too broad when it covers more than eight lines that do something", () => {
    const text = ["const a = 1;", "", "}", ...Array.from({ length: 8 }, (_, index) => `const v${index} = ${index};`)].join("\n");
    const notes = [
      { lines: { start: 1, end: 10 }, text: "Eight statements." },
      { lines: { start: 1, end: 11 }, text: "Nine statements." },
    ];
    expect(coarseNotes(notes, text)).toEqual([notes[1]]);
  });

  it("keeps only names other files could use: identifiers of three characters or more, four at most", () => {
    const parsed = parse([block(1, 3, "Exports", ["cartTotal", "x", "not a name", "Cart", "cartTotal", "addItem", "removeItem", "clearCart"])]);
    expect(parsed?.view === "walkthrough" && parsed.blocks[0]?.symbols).toEqual(["cartTotal", "Cart", "addItem", "removeItem"]);
  });

  it("reads line numbers written as strings, and drops only the block that is malformed", () => {
    const parsed = parseAnswer(
      "walkthrough",
      JSON.stringify({ overview: "", blocks: [{ ...block(1, 5, "Top"), end: "5" }, { ...block(6, 9, "Broken"), title: 7 }, block(10, 12, "Bottom")] }),
      file(20),
      "",
    );
    expect(parsed?.view === "walkthrough" && parsed.blocks.map((kept) => [kept.title, kept.lines])).toEqual([
      ["Top", { start: 1, end: 5 }],
      ["Bottom", { start: 10, end: 12 }],
    ]);
  });

  it("refuses an answer whose blocks all fall outside the part", () => {
    expect(parseAnswer("walkthrough", JSON.stringify({ overview: "", blocks: [block(50, 60, "Elsewhere")] }), { start: 1, end: 40 }, "")).toBeNull();
    expect(parse([])).toBeNull();
  });

  it("joins parts in file order with the first part's overview", () => {
    const first = parseAnswer("walkthrough", JSON.stringify({ overview: "A cart.", blocks: [block(1, 9, "Top")] }), { start: 1, end: 10 }, "")!;
    const second = parseAnswer("walkthrough", JSON.stringify({ overview: "", blocks: [block(11, 20, "Bottom")] }), { start: 11, end: 20 }, "")!;
    expect(joinParts([first, second])).toMatchObject({ view: "walkthrough", overview: "A cart.", blocks: [{ title: "Top" }, { title: "Bottom" }] });
  });
});

describe("diagram answers", () => {
  const node = (id: string, kind: string, start: number | null = null, end: number | null = null) => ({ id, label: `Node ${id}`, kind, summary: "Does a thing.", detail: "More.", start, end });

  it("keeps the first node of each id, makes unknown kinds steps, and drops edges to nodes that don't exist", () => {
    const parsed = parseAnswer(
      "diagram",
      JSON.stringify({
        summary: "Totals a cart.",
        nodes: [node("load", "entry", 1, 4), node("load", "output"), node("sum", "loop", 30, 90), node("done", "output")],
        edges: [
          { from: "load", to: "sum", label: "items" },
          { from: "sum", to: "sum", label: "for each item" },
          { from: "sum", to: "ghost", label: null },
          { from: "load", to: "sum", label: "again" },
          { from: "sum", to: "done", label: "" },
        ],
      }),
      file(40),
      "",
    );
    expect(parsed).toEqual({
      view: "diagram",
      summary: "Totals a cart.",
      nodes: [
        { id: "load", label: "Node load", kind: "entry", summary: "Does a thing.", detail: "More.", lines: { start: 1, end: 4 } },
        { id: "sum", label: "Node sum", kind: "step", summary: "Does a thing.", detail: "More.", lines: { start: 30, end: 40 } },
        { id: "done", label: "Node done", kind: "output", summary: "Does a thing.", detail: "More.", lines: null },
      ],
      edges: [
        { from: "load", to: "sum", label: "items" },
        { from: "sum", to: "sum", label: "for each item" },
        { from: "sum", to: "done", label: null },
      ],
    });
  });

  it("refuses a diagram with no nodes", () => {
    expect(parseAnswer("diagram", JSON.stringify({ summary: "", nodes: [], edges: [] }), file(10), "")).toBeNull();
  });
});
