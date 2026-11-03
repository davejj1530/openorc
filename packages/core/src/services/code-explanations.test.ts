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
const complete = vi.fn(async () => ({ kind: "answered" as const, text: JSON.stringify({ overview: "", blocks }), model: { provider: "claude" as const, label: "Claude Haiku 4.5" } }));

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
