import { describe, expect, it } from "vitest";
import { markPieces, piecesText, sourcesKey, type MarkSources } from "./message-marks";

const paper = { name: "paper", title: "Paper", logo: "data:image/png;base64,AA==" };
const sources: MarkSources = {
  commands: [
    { name: "code-review", insert: true, prefix: "/", aliases: ["review"] },
    { name: "figma:figma-use", insert: true, prefix: "/" },
    { name: "figma", insert: true, prefix: "/" },
    { name: "compact" },
  ],
  connectors: [paper],
  members: [{ key: "rini", name: "Rini" }],
  files: ["src/app.ts", "docs/my notes.md"],
};
const marks = (text: string, from: MarkSources = sources) => markPieces(text, from).flatMap((piece) => (piece.mark ? [[piece.mark.kind, piece.text]] : []));

describe("markPieces", () => {
  it("marks each kind a message can name, and only names its sources list", () => {
    expect(marks("ask @Rini and @paper to run /code-review on src/app.ts and docs/my notes.md")).toEqual([
      ["member", "@Rini"],
      ["connector", "@paper"],
      ["skill", "/code-review"],
      ["file", "src/app.ts"],
      ["file", "docs/my notes.md"],
    ]);
    expect(marks("/compact, @Pip, @papers, src/app.tsx, me@paper.com, https://x.dev/code-review")).toEqual([]);
  });

  it("takes the longest name, a skill's other names, and stops a name at the word's end", () => {
    expect(marks("/figma:figma-use then /figma and /review.")).toEqual([
      ["skill", "/figma:figma-use"],
      ["skill", "/figma"],
      ["skill", "/review"],
    ]);
    expect(marks("/code-reviewer /code-review/x")).toEqual([]);
  });

  it("reads a Codex agent's skills by their dollar sign", () => {
    expect(marks("run $code-review, not /code-review", { commands: [{ name: "code-review", insert: true, prefix: "$" }] })).toEqual([["skill", "$code-review"]]);
  });

  it("gives the message back unchanged from its pieces, whatever it holds", () => {
    const samples = ["", "\n", "plain words", "@Rini\n/code-review\n\n src/app.ts ", " @paper@paper /code-review/code-review", "تحقق من /code-review", "😀 @Rini 😀", "\t/figma\t"];
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const words = ["@Rini", "@paper", "/code-review", "src/app.ts", "x", " ", "\n", "/", "@", "$code-review", "é"];
    for (let i = 0; i < 300; i++) samples.push(Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * words.length)]).join(""));
    for (const text of samples) expect(piecesText(markPieces(text, sources))).toBe(text);
  });
});

describe("sourcesKey", () => {
  it("is the same for lists rebuilt with the same names, and differs when a name or an image changes", () => {
    expect(sourcesKey({ ...sources, commands: [...sources.commands!] })).toBe(sourcesKey(sources));
    expect(sourcesKey({ ...sources, connectors: [{ ...paper, logo: null }] })).not.toBe(sourcesKey(sources));
    expect(sourcesKey({ ...sources, files: [] })).not.toBe(sourcesKey(sources));
  });
});
