import { describe, expect, it } from "vitest";
import { emptyRowMemo, endMark, fixedHeight, isNews, newestRow, transcriptRows, unsentRows, withWaitingApprovals, type Row } from "./rows";
import { activity, finishedTurn, runStore, type Draft } from "./test-fixtures/run-store";

const outline = (rows: Row[]) => rows.map((row) => row.key);

describe("transcriptRows", () => {
  it("reads a turn as prompt, head, folded work and reply", () => {
    const { frame } = runStore();
    const run = frame(...finishedTurn);
    expect(outline(transcriptRows(run.blocks, activity(run), "r", emptyRowMemo()))).toEqual([
      "prompt:ask-1",
      expect.stringMatching(/^head:/),
      expect.stringMatching(/^work:/),
      "reply:reply-1:0",
      expect.stringMatching(/^actions:/),
      "presence",
    ]);
  });

  it("hands the list the same rows while a word streams: the streaming piece reads its words from the run", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    let run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "And the tests?" },
      { type: "tool.started", toolCallId: "test", name: "commandExecution", input: { command: "pnpm test" }, parentToolCallId: null },
      { type: "tool.completed", toolCallId: "test", name: "commandExecution", output: "ok", isError: false },
      { type: "message.delta", messageId: "reply-2", role: "assistant", text: "All " },
    );
    const memo = emptyRowMemo();
    const before = transcriptRows(run.blocks, activity(run), "r", memo);
    run = frame({ type: "message.delta", messageId: "reply-2", role: "assistant", text: "tests pass." });
    const after = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(after).toBe(before);
    expect(after.at(-2)).toMatchObject({ kind: "reply", streaming: true, source: { runId: "r", blockId: "reply-2", index: 0 } });
    run = frame({ type: "message.completed", messageId: "reply-2", role: "assistant", text: "All tests pass." }, { type: "turn.completed", turnId: "t2", status: "success", durationMs: 900 });
    const done = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(done.findLast((row) => row.kind === "reply")).toMatchObject({ kind: "reply", text: "All tests pass.", streaming: false });
  });

  it("draws a long reply in pieces; a piece that fills hands over to a new one, and only those two rows change", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    const paragraph = (n: number) => `Paragraph ${n}. ${"A sentence that fills the reply. ".repeat(12)}`;
    const text = (count: number) => Array.from({ length: count }, (_, i) => paragraph(i + 1)).join("\n\n");
    frame({ type: "turn.started", turnId: "t2" }, { type: "message.completed", messageId: "ask-2", role: "user", text: "Explain" });
    let run = frame({ type: "message.delta", messageId: "long", role: "assistant", text: text(5) });
    const memo = emptyRowMemo();
    const before = transcriptRows(run.blocks, activity(run), "r", memo);
    const pieces = (rows: Row[]) => rows.filter((row) => row.kind === "reply" && row.key.startsWith("reply:long:"));
    expect(pieces(before).map((row) => row.kind === "reply" && row.streaming)).toEqual([false, true]);
    run = frame({ type: "message.delta", messageId: "long", role: "assistant", text: `\n\n${paragraph(6)}` });
    expect(transcriptRows(run.blocks, activity(run), "r", memo)).toBe(before);
    run = frame({ type: "message.delta", messageId: "long", role: "assistant", text: `\n\n${paragraph(7)}` });
    const after = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(pieces(after).map((row) => row.kind === "reply" && row.streaming)).toEqual([false, false, true]);
    const changed = after.filter((row) => !before.includes(row)).map((row) => row.key);
    expect(changed).toEqual(["reply:long:1", "reply:long:2"]);
  });

  it("holds every row while a running command prints or untitled reasoning grows, which the work row does not draw", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    let run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "Build it" },
      { type: "thinking.delta", messageId: "why", text: "I should build " },
    );
    const memo = emptyRowMemo();
    const thinking = transcriptRows(run.blocks, activity(run), "r", memo);
    run = frame({ type: "thinking.delta", messageId: "why", text: "the package first." });
    expect(transcriptRows(run.blocks, activity(run), "r", memo)).toBe(thinking);
    run = frame({ type: "thinking.delta", messageId: "why", text: "\n\n**Building the package**\n\nRunning the build." });
    const titled = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(titled.filter((row, i) => row !== thinking[i]).map((row) => row.kind)).toEqual(["work"]);
    run = frame({ type: "tool.started", toolCallId: "build", name: "commandExecution", input: { command: "pnpm build" }, parentToolCallId: null });
    const running = transcriptRows(run.blocks, activity(run), "r", memo);
    run = frame({ type: "tool.output.delta", toolCallId: "build", text: "vite building\n" }, { type: "tool.output.delta", toolCallId: "build", text: "dist/index.js\n" });
    expect(transcriptRows(run.blocks, activity(run), "r", memo)).toBe(running);
    run = frame({ type: "tool.updated", toolCallId: "build", progress: "2 of 3" });
    expect(
      transcriptRows(run.blocks, activity(run), "r", memo)
        .filter((row, i) => row !== running[i])
        .map((row) => row.kind),
    ).toEqual(["work"]);
  });

  it("holds every row while titled reasoning grows under the same titles, and changes the work row for a new title", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    let run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "Build it" },
      { type: "thinking.delta", messageId: "why", text: "**Building the package**\n\nRunning" },
    );
    const memo = emptyRowMemo();
    const building = transcriptRows(run.blocks, activity(run), "r", memo);
    run = frame({ type: "thinking.delta", messageId: "why", text: " the build first." });
    expect(transcriptRows(run.blocks, activity(run), "r", memo)).toBe(building);
    run = frame({ type: "thinking.delta", messageId: "why", text: "\n\n**Checking the output**\n\nIt" });
    expect(
      transcriptRows(run.blocks, activity(run), "r", memo)
        .filter((row, i) => row !== building[i])
        .map((row) => row.kind),
    ).toEqual(["work"]);
  });

  it("opens a step when its first words follow its title, so the reader sees them stream, then holds again", () => {
    // Codex streams a title and its words separately, and the phone publishes a frame between them.
    const { frame } = runStore();
    frame(...finishedTurn);
    let run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "Check it" },
      { type: "thinking.delta", messageId: "why", text: "**Checking the build output**" },
    );
    const memo = emptyRowMemo();
    const titled = transcriptRows(run.blocks, activity(run), "r", memo);
    run = frame({ type: "thinking.delta", messageId: "why", text: "\n\nThe build printed" });
    const worded = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(worded.filter((row, i) => row !== titled[i]).map((row) => row.kind)).toEqual(["work"]);
    run = frame({ type: "thinking.delta", messageId: "why", text: " two warnings." });
    expect(transcriptRows(run.blocks, activity(run), "r", memo)).toBe(worded);
  });

  it("changes only the work row while a step runs, and the head once the turn ends", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    let run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "Build it" },
      { type: "tool.started", toolCallId: "build", name: "commandExecution", input: { command: "pnpm build" }, parentToolCallId: null },
    );
    const memo = emptyRowMemo();
    const running = transcriptRows(run.blocks, activity(run), "r", memo);
    run = frame({ type: "tool.updated", toolCallId: "build", progress: "Bundling" });
    const progressed = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(progressed.filter((row, i) => row !== running[i]).map((row) => row.kind)).toEqual(["work"]);
    run = frame(
      { type: "tool.completed", toolCallId: "build", name: "commandExecution", output: "built", isError: false },
      { type: "turn.completed", turnId: "t2", status: "success", durationMs: 900 },
    );
    const ended = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(ended.slice(0, 4)).toEqual(progressed.slice(0, 4));
    expect(ended.filter((row, i) => row !== progressed[i]).map((row) => row.kind)).toEqual(["head", "work", "presence"]);
  });

  it("spaces turns in the desktop's rhythm: 28 under a prompt, 14 between a turn's parts, 24 before the next turn, the work's receipt keeping its own 14 around it", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    const run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "And again" },
      { type: "message.completed", messageId: "reply-2", role: "assistant", text: "Again." },
      { type: "turn.completed", turnId: "t2", status: "success", durationMs: 500 },
    );
    const rows = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo());
    expect(rows.map((row) => [row.kind, row.gap])).toEqual([
      ["prompt", 24],
      ["head", 28],
      ["work", 0],
      ["reply", 0],
      ["actions", 10],
      ["prompt", 24],
      ["head", 28],
      ["reply", 14],
      ["actions", 10],
      ["presence", 14],
    ]);
  });

  it("lets the space under a turn's work be its receipt's, so the next turn and the agent's presence sit their usual distance below", () => {
    const { frame } = runStore();
    const run = frame(
      { type: "session.started", agent: "codex", externalSessionId: "s", model: "gpt", tools: [] },
      { type: "turn.started", turnId: "t1" },
      { type: "message.completed", messageId: "ask-1", role: "user", text: "List the folder" },
      { type: "tool.started", toolCallId: "ls", name: "commandExecution", input: { command: "ls" }, parentToolCallId: null },
      { type: "tool.completed", toolCallId: "ls", name: "commandExecution", output: "a", isError: false },
      { type: "turn.completed", turnId: "t1", status: "cancelled", durationMs: 500 },
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "Run the tests" },
      { type: "tool.started", toolCallId: "test", name: "commandExecution", input: { command: "pnpm test" }, parentToolCallId: null },
    );
    const rows = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo());
    expect(rows.map((row) => [row.kind, row.gap])).toEqual([
      ["prompt", 24],
      ["head", 28],
      ["work", 0],
      ["prompt", 10],
      ["head", 28],
      ["work", 0],
      ["presence", 0],
    ]);
  });

  it("keeps a steer the turn ended without answering with the turn it steered, not as a head over nothing", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "Write it slowly" },
      { type: "message.delta", messageId: "reply-2", role: "assistant", text: "Sentence one." },
    );
    frame({ type: "message.completed", messageId: "steer", role: "user", text: "Mention the tests" });
    const run = frame(
      { type: "message.completed", messageId: "reply-2", role: "assistant", text: "Sentence one. Sentence two." },
      { type: "turn.completed", turnId: "t2", status: "cancelled", durationMs: 26_000 },
    );
    const rows = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo());
    expect(outline(rows).slice(5)).toEqual(["prompt:ask-2", "prompt:steer", "head:r:1/ask-2", "reply:reply-2:0", "actions:r:1/ask-2", "presence"]);
    expect(rows.find((row) => row.key === "head:r:1/ask-2")).toMatchObject({ outcome: "cancelled", durationMs: 26_000 });
  });

  it("sets a turn that answers a prompt sent as a turn of its own 28 below it, as the desktop does", () => {
    const { frame } = runStore();
    const run = frame(
      { type: "session.started", agent: "codex", externalSessionId: "s", model: "gpt", tools: [] },
      { type: "turn.started", turnId: "t1" },
      { type: "message.completed", messageId: "ask", role: "user", text: "Hello" },
      { type: "turn.completed", turnId: "t1", status: "success", durationMs: 100 },
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "reply", role: "assistant", text: "Hi." },
      { type: "turn.completed", turnId: "t2", status: "success", durationMs: 500 },
    );
    const rows = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo());
    expect(rows.slice(0, 2).map((row) => [row.kind, row.gap])).toEqual([
      ["prompt", 24],
      ["head", 28],
    ]);
  });

  it("keeps the agent's presence working while the thread is, after its turn ended on background work", () => {
    const { frame } = runStore();
    const run = frame(...finishedTurn);
    expect(transcriptRows(run.blocks, { live: true, working: true }, "r", emptyRowMemo()).at(-1)).toMatchObject({ kind: "presence", working: true });
    expect(transcriptRows(run.blocks, { live: true, working: false }, "r", emptyRowMemo()).at(-1)).toMatchObject({ kind: "presence", working: false });
  });

  it("sets a turn 28 below the lone prompt an older page ends in, once that page loads above it", () => {
    const { frame } = runStore();
    const run = frame(
      { type: "session.started", agent: "codex", externalSessionId: "s", model: "gpt", tools: [] },
      { type: "turn.started", turnId: "t1" },
      { type: "message.completed", messageId: "ask", role: "user", text: "Hello" },
      { type: "turn.completed", turnId: "t1", status: "success", durationMs: 100 },
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "reply", role: "assistant", text: "Hi." },
      { type: "turn.completed", turnId: "t2", status: "success", durationMs: 500 },
    );
    const memo = emptyRowMemo();
    // The first page holds only the answer; the older page keeps its blocks' objects when it lands.
    const answer = run.blocks.slice(run.blocks.findIndex((block) => block.id === "reply"));
    expect(transcriptRows(answer, activity(run), "r", memo)[0]).toMatchObject({ kind: "head", gap: 24 });
    const rows = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(rows.slice(0, 2).map((row) => [row.kind, row.gap])).toEqual([
      ["prompt", 24],
      ["head", 28],
    ]);
  });

  it("offers a finished reply's actions, and keeps the agent's presence at the end, working while the turn runs", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    const memo = emptyRowMemo();
    let run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "More" },
      { type: "message.delta", messageId: "reply-2", role: "assistant", text: "Wor" },
    );
    let rows = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(rows.filter((row) => row.kind === "actions").map((row) => row.kind === "actions" && row.text)).toEqual(["Done."]);
    expect(rows.at(-1)).toMatchObject({ kind: "presence", working: true });
    run = frame({ type: "message.completed", messageId: "reply-2", role: "assistant", text: "Working." }, { type: "turn.completed", turnId: "t2", status: "success", durationMs: 500 });
    rows = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(rows.filter((row) => row.kind === "actions").map((row) => row.kind === "actions" && row.text)).toEqual(["Done.", "Working."]);
    expect(rows.at(-1)).toMatchObject({ kind: "presence", working: false });
  });

  it("names the newest row above the agent's presence, so what lands while the reader is up is news", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    const memo = emptyRowMemo();
    let run = frame({ type: "turn.started", turnId: "t2" }, { type: "message.completed", messageId: "ask-2", role: "user", text: "More" });
    expect(newestRow(transcriptRows(run.blocks, activity(run), "r", memo))?.kind).toBe("head");
    run = frame({ type: "message.delta", messageId: "reply-2", role: "assistant", text: "Wor" });
    const rows = transcriptRows(run.blocks, activity(run), "r", memo);
    expect(rows.at(-1)?.kind).toBe("presence");
    expect(newestRow(rows)?.key).toBe("reply:reply-2:0");
  });

  it("counts a streaming reply growing inside its row as news, as well as a new row", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    const memo = emptyRowMemo();
    let run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "More" },
      { type: "message.delta", messageId: "reply-2", role: "assistant", text: "Wor" },
    );
    let rows = transcriptRows(run.blocks, activity(run), "r", memo);
    const seen = endMark(rows, run.blocks);
    expect(isNews(seen, seen)).toBe(false);
    run = frame({ type: "message.delta", messageId: "reply-2", role: "assistant", text: "king on it" });
    rows = transcriptRows(run.blocks, activity(run), "r", memo);
    const grown = endMark(rows, run.blocks);
    expect(grown.row).toBe(seen.row);
    expect(isNews(seen, grown)).toBe(true);
    expect(isNews(null, grown)).toBe(false);
  });

  it("gives the list the exact height of the rows that never change theirs, and leaves the rest to be measured", () => {
    const { frame } = runStore();
    const run = frame(...finishedTurn);
    const heights = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo()).map((row) => [row.kind, fixedHeight(row)]);
    expect(heights).toEqual([
      ["prompt", undefined],
      ["head", 28 + 16],
      ["work", undefined],
      ["reply", undefined],
      ["actions", 10 + 30],
      ["presence", 14 + 36],
    ]);
  });

  it("puts an approval after the work as a card that answers for its run", () => {
    const { frame } = runStore();
    const run = frame(
      { type: "session.started", agent: "codex", externalSessionId: "s", model: "gpt", tools: [] },
      { type: "turn.started", turnId: "t1" },
      { type: "message.completed", messageId: "ask", role: "user", text: "Clean up" },
      { type: "tool.started", toolCallId: "rm", name: "commandExecution", input: { command: "rm -rf dist" }, parentToolCallId: null },
      { type: "approval.requested", approvalId: "ap", kind: "command", toolName: "Bash", input: { command: "rm -rf dist" }, reason: "Deletes files" },
    );
    const rows = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo());
    expect(rows.at(-2)).toMatchObject({ kind: "card", runId: "r", block: { kind: "approval", approvalId: "ap" } });
    expect(rows.find((row) => row.kind === "head")).toMatchObject({ live: true, writing: false });
  });

  it("names the question cards still waiting for an answer, so the list keeps what the reader typed", () => {
    const { frame } = runStore();
    frame(...finishedTurn);
    const ask: Draft = { type: "approval.requested", approvalId: "q", kind: "user_input", input: { questions: [{ id: "runner", question: "Which runner?" }] } };
    const shell: Draft = { type: "approval.requested", approvalId: "a", kind: "command", input: { command: "ls" } };
    let run = frame({ type: "turn.started", turnId: "t2" }, { type: "message.completed", messageId: "ask-2", role: "user", text: "Pick a runner" }, ask, shell);
    expect(unsentRows(transcriptRows(run.blocks, activity(run), "r", emptyRowMemo()))).toEqual(["card:approval-q"]);
    run = frame({ type: "approval.resolved", approvalId: "q", decision: "allow", answers: { runner: ["Vitest"] } });
    expect(unsentRows(transcriptRows(run.blocks, activity(run), "r", emptyRowMemo()))).toEqual([]);
  });
});

describe("withWaitingApprovals", () => {
  const approval = (id: string) => ({ id, kind: "approval", approvalId: id, approvalKind: "command", input: { command: "ls" } }) as const;

  it("adds a head and the cards of each waiting run after the conversation, before the agent's presence, keyed by run", () => {
    const { frame } = runStore();
    const run = frame(...finishedTurn);
    const conversation = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo());
    const rows = withWaitingApprovals(conversation, [
      { runId: "fix", task: "Fix the flaky test", blocks: [approval("0"), approval("1")] },
      { runId: "lead", task: null, blocks: [approval("0")] },
    ]);
    expect(outline(rows).slice(conversation.length - 1)).toEqual(["waiting:fix", "card:fix:0", "card:fix:1", "waiting:lead", "card:lead:0", "presence"]);
    expect(rows.find((row) => row.key === "waiting:fix")).toMatchObject({ kind: "waiting", runId: "fix", title: "Fix the flaky test", gap: 24 });
    expect(rows.find((row) => row.key === "waiting:lead")).toMatchObject({ kind: "waiting", runId: "lead", title: null });
    expect(rows.find((row) => row.key === "card:lead:0")).toMatchObject({ kind: "card", runId: "lead", gap: 14 });
    expect(newestRow(rows)).toMatchObject({ key: "card:lead:0" });
    expect(fixedHeight(rows.find((row) => row.kind === "waiting")!)).toBe(24 + 16);
  });

  it("hands back the conversation's own rows when nothing waits", () => {
    const { frame } = runStore();
    const run = frame(...finishedTurn);
    const conversation = transcriptRows(run.blocks, activity(run), "r", emptyRowMemo());
    expect(withWaitingApprovals(conversation, [])).toBe(conversation);
  });
});
