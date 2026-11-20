import { expect, it } from "vitest";
import { emptyRowMemo, transcriptRows, type Row } from "./rows";
import { proofAt, withProofs, type ReplyProof } from "./reply-proof";
import { activity, runStore, type Draft } from "./test-fixtures/run-store";

const turn = (reply: Draft[]): Draft[] => [
  { type: "session.started", agent: "claude", externalSessionId: "s", model: "m", tools: [] },
  { type: "turn.started", turnId: "t1" },
  { type: "message.completed", messageId: "ask", role: "user", text: "Lock accounts" },
  { type: "tool.started", toolCallId: "edit", name: "Edit", input: { file_path: "/repo/src/auth.ts", old_string: "refuse(401)", new_string: "refuse(423)" }, parentToolCallId: null },
  { type: "tool.completed", toolCallId: "edit", name: "Edit", output: "The file has been updated", isError: false },
  { type: "tool.started", toolCallId: "test", name: "Bash", input: { command: "npx vitest run" }, parentToolCallId: null },
  { type: "tool.completed", toolCallId: "test", name: "Bash", output: " Test Files  3 passed (3)\n      Tests  13 passed (13)", isError: false },
  ...reply,
];
const said = "I changed `src/auth.ts` so the fifth wrong password answers 423.\n\nThe tests pass.";
type ReplyRow = Extract<Row, { kind: "reply" }>;
const proofsOf = (rows: Row[]) => rows.filter((row): row is ReplyRow => row.kind === "reply").flatMap((row) => row.proofs);

it("gives a finished reply the proofs its lines call on, each with the calls behind it", () => {
  const store = runStore();
  const run = store.frame(
    ...turn([
      { type: "message.completed", messageId: "reply", role: "assistant", text: said },
      { type: "turn.completed", turnId: "t1", status: "success", durationMs: 1000 },
    ]),
  );
  const memo = emptyRowMemo();
  const rows = transcriptRows(run.blocks, activity(run), "r", memo);
  expect(proofsOf(rows)).toMatchObject([
    { line: "I changed `src/auth.ts` so the fifth wrong password answers 423.", label: "auth.ts +1 −1", tone: "ok", calls: ["edit"] },
    { line: "The tests pass.", label: "13 passed", tone: "ok", calls: ["test"] },
  ]);
  // The same proofs each time the rows are read, so a finished reply's row stays the row it was.
  const again = transcriptRows(run.blocks, activity(run), "r", memo);
  expect(again.find((row) => row.kind === "reply")).toBe(rows.find((row) => row.kind === "reply"));
});

it("shows no proof while the turn still runs: its work is not done", () => {
  const store = runStore();
  const run = store.frame(...turn([{ type: "message.completed", messageId: "reply", role: "assistant", text: said }]));
  expect(proofsOf(transcriptRows(run.blocks, activity(run), "r", emptyRowMemo()))).toEqual([]);
});

const proof = (line: string, label: string, tone: ReplyProof["tone"]): ReplyProof => ({ line, label, tone, runId: null, calls: ["c"] });

it("writes each pill at the end of the line it stands on, its words in one piece", () => {
  const proofs = [proof("The tests pass.", "13 passed", "ok"), proof("- Lint failed", "Lint failed", "bad")];
  expect(withProofs("Done.\n\nThe tests pass.\n\n- Lint failed\n- The tests pass.", proofs)).toBe(
    "Done.\n\nThe tests pass. [ 13 passed ](proof:ok:0)\n\n- Lint failed [ Lint failed ](proof:bad:1)\n- The tests pass.",
  );
  expect(proofAt("proof:bad:1", proofs)).toBe(proofs[1]);
  expect(proofAt("https://example.com", proofs)).toBeNull();
});
