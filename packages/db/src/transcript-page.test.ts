import { expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { Db } from "./database.js";
import { LedgerWriter } from "./ledger.js";
import { projects, runs, threads } from "./repos.js";
import { digestedEvent, pagedEvent, transcriptPage } from "./transcript-page.js";

function fixture(events: (runId: string) => AgentEvent[]) {
  const db = Db.memory();
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo", gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "t", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  const runId = runs.insert(db, { id: "run-1", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" }).id;
  const writer = new LedgerWriter(db, { artifactThresholdBytes: 1024 });
  for (const ev of events(runId)) writer.push(ev);
  writer.flush();
  return { db, runId };
}

const turn = (runId: string, n: number, output: unknown = `out ${n}`, name = "Bash"): AgentEvent[] => [
  { type: "message.completed", runId, ts: n * 10, messageId: `ask-${n}`, role: "user", text: `ask ${n}` },
  { type: "tool.started", runId, ts: n * 10 + 1, toolCallId: `call-${n}`, name, input: { n }, parentToolCallId: null },
  { type: "tool.completed", runId, ts: n * 10 + 2, toolCallId: `call-${n}`, name, output, isError: false },
  { type: "turn.completed", runId, ts: n * 10 + 3, turnId: `turn-${n}`, status: "success", durationMs: 3 },
];

it("pages a run by turns, newest first, counting turns as the transcript does", () => {
  const { db, runId } = fixture((id) => [{ type: "session.started", runId: id, ts: 0, agent: "claude", externalSessionId: "s", model: null }, ...turn(id, 1), ...turn(id, 2), ...turn(id, 3)]);
  const ids = (events: AgentEvent[]) => events.map((ev) => ("messageId" in ev ? ev.messageId : ev.type));
  expect(transcriptPage(db, runId, { turns: 1 })).toMatchObject({ fromTurn: 2 });
  expect(ids(transcriptPage(db, runId, { turns: 1 }).events)).toEqual(["ask-3", "tool.started", "tool.completed", "turn.completed"]);
  expect(transcriptPage(db, runId, { fromTurn: 1 }).events).toHaveLength(8);
  expect(transcriptPage(db, runId, {}).events).toHaveLength(13);
  expect(transcriptPage(db, runId, { turns: 9 }).fromTurn).toBe(0);
  expect(transcriptPage(db, runId, { fromTurn: 9 })).toEqual({ events: [], fromTurn: 3 });
});

it("leaves the same tool results out of a live event as out of its stored row", () => {
  const { db, runId } = fixture((id) => [...turn(id, 1, "x".repeat(10_000)), ...turn(id, 2, "small"), ...turn(id, 3, { id: "t".repeat(5_000) }, "openorc.task_create")]);
  const completed = (events: AgentEvent[]) => events.filter((ev) => ev.type === "tool.completed");
  const live = completed(turn(runId, 1, "x".repeat(10_000)).concat(turn(runId, 2, "small"), turn(runId, 3, { id: "t".repeat(5_000) }, "openorc.task_create"))).map(pagedEvent);
  const stored = completed(transcriptPage(db, runId, {}).events);
  expect(live.map((ev) => "outputOmitted" in ev && ev.outputOmitted === true)).toEqual([true, false, false]);
  expect(stored.map((ev) => ({ ...ev, eventId: undefined }))).toEqual(live.map((ev) => ({ ...ev, eventId: undefined })));
});

it("keeps what a large result came to once a page leaves its output out", () => {
  const vitest = ` ✓ src/a.test.ts (11 tests) 40ms\n${"noise\n".repeat(900)} FAIL  src/b.test.ts > queue > sends the head once\nAssertionError: expected "send" to be called 1 time, but got 2 times\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 11 passed (12)\n   Duration  912ms (transform 61ms, setup 0ms)\n`;
  const { db, runId } = fixture((id) => [...turn(id, 1, vitest).map(digestedEvent), ...turn(id, 2, "small").map(digestedEvent)]);
  const [large, small] = transcriptPage(db, runId, {}).events.filter((ev) => ev.type === "tool.completed");
  expect(large).toMatchObject({ outputOmitted: true, digest: { tests: { passed: 11, failed: 1, finished: true, failures: [{ name: "sends the head once" }] } } });
  expect(small).toMatchObject({ output: "small" });
  expect(small).not.toHaveProperty("digest");
});
