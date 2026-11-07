import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderPath, type FindQuery, type FindResult } from "@openorc/protocol";
import { CodeExplanationService } from "./code-explanations.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openorc-explanations-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const text = "export type Props = {};\nexport const cartTotal = 1;\n";
const blocks = [
  { start: 1, end: 1, title: "Props", explanation: "", symbols: ["Props"] },
  { start: 2, end: 2, title: "Total", explanation: "", symbols: ["cartTotal"] },
];
const complete = vi.fn(async ({ prompt }: { prompt: string }) => ({
  kind: "answered" as const,
  text: JSON.stringify(prompt.includes("statement by statement") ? { notes: [{ line: 1, code: "", text: "Two lines." }] } : { overview: "", blocks }),
  model: { provider: "claude" as const, label: "Claude Haiku 4.5" },
}));

it("looks names up one at a time when a shared find reached its limit, and leaves out a name too common to tell", async () => {
  const caller = { path: "src/z-checkout.ts", lines: [{ line: 3, text: "cartTotal + 1" }] };
  const flood = Array.from({ length: 100 }, (_, index) => ({ path: `src/props-${index}.ts`, lines: [{ line: 1, text: "Props" }] }));
  const find = vi.fn(async (query: FindQuery): Promise<FindResult> => {
    const props = query.text.includes("Props");
    const total = query.text.includes("cartTotal");
    if (props) return { kind: "matches", groups: flood, truncated: true };
    return { kind: "matches", groups: total ? [caller] : [], truncated: false };
  });
  const service = new CodeExplanationService({ dir, complete });
  const result = await service.explain({ path: FolderPath.parse("src/cart.ts"), text, view: "walkthrough" }, { agent: "claude", find });
  expect(find.mock.calls.map(([query]) => query.text.includes("Props") && query.text.includes("cartTotal"))).toEqual([true, false, false]);
  expect(result.kind === "explained" && result.explanation.view === "walkthrough" && result.explanation.blocks.map((block) => block.usedBy.map((usage) => usage.path))).toEqual([
    [],
    ["src/z-checkout.ts"],
  ]);
});

const values = (count: number) => Array.from({ length: count }, (_, index) => `const v${index} = ${index};`).join("\n") + "\n";
const reply = (notes: unknown[]) => ({ kind: "answered" as const, text: JSON.stringify({ notes }), model: { provider: "claude" as const, label: "Claude Haiku 4.5" } });
const each = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ line: from + index, end: from + index, code: `const v${from + index - 1} = ${from + index - 1};`, text: `Line ${from + index}.` }));

it("asks again, saying why, about a note that folds too many lines together, and uses the finer notes in its place", async () => {
  const asked: { range: string; split: boolean }[] = [];
  const answers = vi.fn(async ({ prompt }: { prompt: string }) => {
    const [, start, end] = /Explain lines (\d+) to (\d+)/.exec(prompt)!;
    asked.push({ range: `${start}-${end}`, split: prompt.includes("were explained before in a single note") });
    return reply(asked.length === 1 ? [{ line: 1, end: 10, code: "const v0", text: "All of them." }] : each(1, 10));
  });
  const service = new CodeExplanationService({ dir, complete: answers });
  const result = await service.explain({ path: FolderPath.parse("src/values.ts"), text: values(10), view: "english" }, { agent: "claude", find: vi.fn() });
  expect(asked).toEqual([
    { range: "1-10", split: false },
    { range: "1-10", split: true },
  ]);
  expect(result.kind === "explained" && result.explanation.view === "english" && result.explanation.notes.map((note) => note.text)).toEqual(each(1, 10).map((note) => note.text));
});

it("keeps a broad note's opening lines in front of the finer notes that replace it", async () => {
  const answers = vi.fn(async () => reply(answers.mock.calls.length === 1 ? [{ line: 1, end: 10, code: "const v0", text: "The whole list." }] : each(3, 10)));
  const service = new CodeExplanationService({ dir, complete: answers });
  const result = await service.explain({ path: FolderPath.parse("src/values.ts"), text: values(10), view: "english" }, { agent: "claude", find: vi.fn() });
  expect(result.kind === "explained" && result.explanation.view === "english" && result.explanation.notes.map((note) => [note.lines.start, note.lines.end, note.text])).toEqual([
    [1, 2, "The whole list."],
    ...each(3, 10).map((note) => [note.line, note.line, note.text]),
  ]);
});

it("asks about a stretch the model skipped on its own, and fills it in", async () => {
  const asked: string[] = [];
  const answers = vi.fn(async ({ prompt }: { prompt: string }) => {
    const [, start, end] = /Explain lines (\d+) to (\d+)/.exec(prompt)!;
    asked.push(`${start}-${end}`);
    return reply(asked.length === 1 ? [...each(1, 2), ...each(7, 8)] : each(Number(start), Number(end)));
  });
  const service = new CodeExplanationService({ dir, complete: answers });
  const result = await service.explain({ path: FolderPath.parse("src/values.ts"), text: values(8), view: "english" }, { agent: "claude", find: vi.fn() });
  expect(asked).toEqual(["1-8", "3-6"]);
  expect(result.kind === "explained" && result.explanation.view === "english" && result.explanation.notes.map((note) => note.lines.start)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});
