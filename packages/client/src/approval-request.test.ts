import { expect, it } from "vitest";
import { approvalDetail, approvalSummary, readQuestions } from "./approval-request.js";
import type { Block } from "./transcript.js";

it("keys a Codex answer by the question's id and a Claude answer by its text", () => {
  const codex = readQuestions({ questions: [{ id: "runner", question: "Which runner?", isOther: true, options: [{ label: "Vitest", description: "Same as the rest" }] }] });
  const claude = readQuestions({ questions: [{ question: "Which runner?", header: "Runner", multiSelect: true, options: [{ label: "Vitest" }] }] });
  expect(codex).toEqual([{ key: "runner", header: "", question: "Which runner?", options: [{ label: "Vitest", description: "Same as the rest" }], allowOther: true, secret: false, multi: false }]);
  expect(claude[0]).toMatchObject({ key: "Which runner?", header: "Runner", allowOther: true, multi: true });
});

const approval = (input: unknown) => ({ kind: "approval", id: "a", approvalId: "a", approvalKind: "command", input }) as Extract<Block, { kind: "approval" }>;

it("shows the command of a shell approval and the arguments of a tool call", () => {
  expect(approvalDetail(approval({ command: "git push --force" }))).toBe("git push --force");
  expect(approvalDetail(approval({ _meta: { tool_params: { query: "screens" } } }))).toEqual({ query: "screens" });
  expect(approvalDetail(approval({ tool: "Write", input: { path: "a.ts" } }))).toEqual({ path: "a.ts" });
});

it("sums up a short request whole, and a long one by its start and its end, so its last line is read before Allow", () => {
  expect(approvalSummary(approval({ command: "git push --force" }))).toBe("git push --force");
  expect(approvalSummary(approval({ _meta: { tool_params: {} } }))).toBe("no arguments");

  const script = [...Array.from({ length: 29 }, (_, i) => `echo line-${i + 1} of the release checklist`), "git push --force origin main"].join("\n");
  const long = approvalSummary(approval({ command: script })).split("\n");
  expect(long).toHaveLength(16);
  expect(long.slice(0, 2)).toEqual(["echo line-1 of the release checklist", "echo line-2 of the release checklist"]);
  expect(long[8]).toBe("…");
  expect(long.at(-1)).toBe("git push --force origin main");

  // An MCP call's list prints one item a line; the card keeps the first and the last few.
  const ids = approvalSummary(approval({ _meta: { tool_params: { ids: Array.from({ length: 120 }, (_, i) => 1000 + i) } } }));
  expect(ids.split("\n")).toHaveLength(16);
  expect(ids).toMatch(/^\{\n "ids": \[\n  1000,/);
  expect(ids).toMatch(/1119\n \]\n\}$/);

  const line = `curl -d '${"x".repeat(1000)}' https://example.com/upload`;
  const wide = approvalSummary(approval({ command: line }));
  expect(wide.split("\n…\n").map((part) => part.length)).toEqual([300, 300]);
  expect(wide.startsWith("curl -d 'xxx")).toBe(true);
  expect(wide.endsWith("' https://example.com/upload")).toBe(true);
});
