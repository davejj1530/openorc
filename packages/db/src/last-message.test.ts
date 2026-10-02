import { expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { Db } from "./database.js";
import { lastThreadMessage } from "./last-message.js";
import { LedgerWriter } from "./ledger.js";
import { projects, runs, threads } from "./repos.js";

function conversation() {
  const db = Db.memory();
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo", gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Opi", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  const writer = new LedgerWriter(db, { artifactThresholdBytes: 512 });
  const run = (id: string, events: (runId: string) => AgentEvent[], endedAt: number | null = null) => {
    runs.insert(db, { id, taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
    for (const event of events(id)) writer.push(event);
    writer.flush();
    if (endedAt !== null) runs.update(db, id, { endedAt });
  };
  return { db, threadId: thread.id, run };
}

const message = (runId: string, ts: number, role: "user" | "assistant" | "system", text: string): AgentEvent => ({ type: "message.completed", runId, ts, messageId: `${runId}-${ts}`, role, text });

it("reads the newest thing said in a run, past its tool traffic and blank or system messages", () => {
  const { db, threadId, run } = conversation();
  expect(lastThreadMessage(db, threadId, 100)).toBeNull();
  run("run-1", (id) => [
    message(id, 10, "user", "How big is the release?"),
    message(id, 20, "assistant", "About 120 MB."),
    { type: "tool.started", runId: id, ts: 21, toolCallId: "call", name: "Bash", input: {}, parentToolCallId: null },
    { type: "tool.completed", runId: id, ts: 22, toolCallId: "call", name: "Bash", output: "done", isError: false },
    message(id, 23, "assistant", " \n\n"),
    message(id, 24, "system", "Context compacted."),
  ]);
  expect(lastThreadMessage(db, threadId, 100)).toEqual({ id: "run-1-20", role: "assistant", text: "About 120 MB.", createdAt: 20 });
});

it("finds the newest message across overlapping runs, as when the conversation's own run answers after a guest's", () => {
  const { db, threadId, run } = conversation();
  run("finished", (id) => [message(id, 5, "assistant", "Long done.")], 6);
  run("own", (id) => [message(id, 10, "user", "@Rini what do you think?"), message(id, 40, "assistant", "Back to you.")]);
  run("guest", (id) => [message(id, 20, "assistant", "Rini here.")], 30);
  expect(lastThreadMessage(db, threadId, 100)).toMatchObject({ id: "own-40", text: "Back to you." });
});

it("prefers a newer message recorded on the thread, and clips text stored whole or as an artifact", () => {
  const { db, threadId, run } = conversation();
  run("run-1", (id) => [message(id, 10, "assistant", "Long reply. ".repeat(100))], 11);
  expect(lastThreadMessage(db, threadId, 11)).toMatchObject({ role: "assistant", text: "Long reply." });
  db.stmt("INSERT INTO thread_messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)").run("slack", threadId, "user", "Sent from Slack", 50);
  expect(lastThreadMessage(db, threadId, 4)).toEqual({ id: "slack", role: "user", text: "Sent", createdAt: 50 });
});
