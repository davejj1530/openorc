import { describe, expect, it } from "vitest";
import { explanationPrompt, parseAnswer } from "./code-explanation-answers.js";

describe("the prompt", () => {
  it("numbers every line so the model can cite lines, and keeps CRLF files to the same count", () => {
    const prompt = explanationPrompt("walkthrough", "src/cart.ts", "const a = 1;\r\nconst b = 2;\r\n");
    expect(prompt).toContain("File: src/cart.ts\nIt has 2 lines:\n1| const a = 1;\n2| const b = 2;");
  });
});

describe("Plain English answers", () => {
  it("reads the JSON past a code fence and a sentence around it", () => {
    expect(parseAnswer("english", 'Here you go:\n```json\n{"markdown":"## Cart\\nAdds things up."}\n```', 10)).toEqual({ view: "english", markdown: "## Cart\nAdds things up." });
  });
  it("keeps a code sample's fences inside the explanation while stepping past the fence around the reply", () => {
    const markdown = "Call it:\n\n```ts\nconst due = cartTotal([1, 2]);\n```";
    expect(parseAnswer("english", `\`\`\`json\n${JSON.stringify({ markdown })}\n\`\`\``, 10)).toEqual({ view: "english", markdown });
  });

  it("refuses a reply with no explanation in it", () => {
    expect(parseAnswer("english", "I can't help with that.", 10)).toBeNull();
    expect(parseAnswer("english", '{"markdown":"   "}', 10)).toBeNull();
  });
});

describe("walkthrough answers", () => {
  const block = (start: number, end: number, title: string, symbols: string[] = []) => ({ start, end, title, explanation: `${title} explained`, symbols });
  const parse = (blocks: unknown[], lines = 40) => parseAnswer("walkthrough", JSON.stringify({ overview: "A cart.", blocks }), lines);

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

  it("keeps only names other files could use: identifiers of three characters or more, four at most", () => {
    const parsed = parse([block(1, 3, "Exports", ["cartTotal", "x", "not a name", "Cart", "cartTotal", "addItem", "removeItem", "clearCart"])]);
    expect(parsed?.view === "walkthrough" && parsed.blocks[0]?.symbols).toEqual(["cartTotal", "Cart", "addItem", "removeItem"]);
  });

  it("refuses an answer whose blocks all fall outside the file", () => {
    expect(parse([block(0, -3, "Nowhere")], 10)).toBeNull();
    expect(parse([])).toBeNull();
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
      40,
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
    expect(parseAnswer("diagram", JSON.stringify({ summary: "", nodes: [], edges: [] }), 10)).toBeNull();
  });
});
