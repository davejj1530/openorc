import { describe, expect, it } from "vitest";
import { markdownChunks } from "./markdown-chunks";

const paragraph = (n: number) => `Paragraph ${n} ${"word ".repeat(40).trim()}.`;

describe("markdownChunks", () => {
  it("keeps a short reply whole", () => {
    expect(markdownChunks("Done. **48 of 48** pass.")).toEqual(["Done. **48 of 48** pass."]);
  });

  it("ends a piece between blocks once it reaches the size, and never inside a code fence", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    const text = [paragraph(1), paragraph(2), code, paragraph(3)].join("\n\n");
    const chunks = markdownChunks(text, 300);
    expect(chunks).toEqual([[paragraph(1), paragraph(2)].join("\n\n"), [code, paragraph(3)].join("\n\n")]);
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("keeps a list's items and indented continuations together", () => {
    const list = ["1. First step", "", "2. Second step", "", "   More about the second step", "", "3. Third step"].join("\n");
    expect(markdownChunks([paragraph(1), list].join("\n\n"), 10)).toEqual([paragraph(1), "1. First step\n\n2. Second step\n\n   More about the second step\n\n3. Third step"]);
  });

  it("never moves an earlier boundary as the reply streams in", () => {
    const code = "```js\nlet x = 1;\n\nx++;\n```";
    const loose = (marker: (i: number) => string) => Array.from({ length: 12 }, (_, i) => `${marker(i)} Item ${i + 1} ${"word ".repeat(12).trim()}`).join("\n\n");
    const numbered = loose((i) => `${i + 1}.`);
    const bulleted = loose(() => "-");
    const parenthesized = loose((i) => `${i + 1})`);
    const full = [paragraph(0), paragraph(1), paragraph(2), code, numbered, paragraph(4), paragraph(5), code, bulleted, paragraph(8), parenthesized, paragraph(9), code].join("\n\n");
    const final = markdownChunks(full, 400);
    for (let end = 1; end <= full.length; end++) {
      const partial = markdownChunks(full.slice(0, end), 400);
      // Every piece but the one still growing is already in its final form.
      partial.slice(0, -1).forEach((chunk, index) => expect(chunk).toBe(final[index]));
    }
  });
});
