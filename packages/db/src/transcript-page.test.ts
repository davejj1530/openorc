import { expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { Db } from "./database.js";
import { LedgerWriter } from "./ledger.js";
import { projects, runs, threads } from "./repos.js";
import { transcriptPage } from "./transcript-page.js";

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
