import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "./database.js";
import { projects, threads, runs } from "./repos.js";
import { plans } from "./plans.js";
import type { AgentEvent, HarnessId } from "@openorc/protocol";

function fixture(db = Db.memory(), agent: HarnessId = "codex") {
  const project = projects.insert(db, { name: "Plan", rootPath: "/tmp/plans", gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Plan", agent, model: null, mode: "plan", permissionMode: "review" });
  const run = runs.insert(db, { id: "plan-run", taskId: null, threadId: thread.id, agent, model: null, mode: "plan", permissionMode: "review" });
  const event = (input: Omit<AgentEvent, "runId" | "ts"> & Record<string, unknown>) => plans.capture(db, run, { ...input, runId: run.id, ts: Date.now() } as AgentEvent);
  return { db, thread, run, event, list: () => plans.list(db, thread.id) };
}
it("streams a native document, uses the authoritative completion, and preserves completed revisions", () => {
  const f = fixture();
  try {
    f.event({ type: "plan.updated", documentId: "p", text: "Partial", delta: true });
    expect(f.list()[0]).toMatchObject({ text: "Partial", state: "draft" });
    f.event({ type: "plan.updated", documentId: "p", text: "Complete proposal", complete: true });
    const original = f.list()[0]!;
    f.event({ type: "plan.updated", documentId: "p", text: "Revised proposal", complete: true });
    expect(f.list().map((p) => p.text)).toEqual(["Revised proposal", "Complete proposal"]);
    expect(f.list()[1]).toEqual(original);
    f.event({ type: "turn.completed", turnId: "t", status: "success", durationMs: 1, resultText: "Here is your plan." });
    expect(f.list()).toHaveLength(2);
  } finally {
    f.db.close();
  }
});
it("retains the response fallback for providers without native document events", () => {
  const f = fixture(Db.memory(), "opencode");
  try {
    f.event({ type: "message.delta", role: "assistant", messageId: "progress", text: "Investigating" });
    f.event({ type: "message.delta", role: "assistant", messageId: "final", text: "# Plan" });
    f.event({ type: "turn.completed", turnId: "t", status: "success", durationMs: 1, resultText: "# Plan\nFinal" });
    expect(f.list()).toHaveLength(1);
    expect(f.list()[0]).toMatchObject({ text: "# Plan\nFinal", state: "ready", source: "response" });
    f.event({ type: "plan.updated", documentId: "next", text: "unfinished" });
    f.event({ type: "session.completed", status: "error", durationMs: 1 });
    expect(f.list()[0]?.state).toBe("interrupted");
    expect(plans.capture(f.db, { ...f.run, mode: "act" }, { type: "plan.updated", runId: f.run.id, ts: Date.now(), documentId: "act-checklist", text: "Not a proposed plan" })).toBe(false);
  } finally {
    f.db.close();
  }
});

it("retains the native document when a later turn repeats it with a short final acknowledgment", () => {
  const f = fixture();
  try {
    const capture = (event: AgentEvent) => plans.capture(f.db, f.run, event);
    capture({ type: "turn.started", runId: f.run.id, turnId: "one", ts: 10 });
    capture({ type: "plan.updated", runId: f.run.id, documentId: "plan.md", text: "Full proposal", complete: true, ts: 11 });
    capture({ type: "turn.completed", runId: f.run.id, turnId: "one", status: "success", durationMs: 1, ts: 12 });
    capture({ type: "turn.started", runId: f.run.id, turnId: "two", ts: 20 });
    capture({ type: "plan.updated", runId: f.run.id, documentId: "plan.md", text: "Full proposal", complete: true, ts: 21 });
    capture({ type: "turn.completed", runId: f.run.id, turnId: "two", status: "success", durationMs: 1, resultText: "Still ready", ts: 22 });
    expect(f.list().map((p) => p.text)).toEqual(["Full proposal"]);
  } finally {
    f.db.close();
  }
});

it("reopens saved revisions and recovers only unfinished drafts from the on-disk database", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openorc-plan-db-"));
  const filename = path.join(dir, "ledger.sqlite");
  const f = fixture(Db.open(filename));
  f.event({ type: "plan.updated", documentId: "one", text: "# Saved plan", complete: true });
  f.event({ type: "plan.updated", documentId: "two", text: "Unfinished revision" });
  const saved = f.list()[1];
  f.db.close();
  const reopened = Db.open(filename);
  try {
    plans.recover(reopened);
    expect(plans.list(reopened, f.thread.id)[0]?.state).toBe("interrupted");
    expect(plans.list(reopened, f.thread.id)[1]).toEqual(saved);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps Codex discussion out of plans, including legacy response copies", () => {
  const f = fixture();
  try {
    f.event({ type: "turn.started", turnId: "discussion" });
    expect(f.event({ type: "message.delta", role: "assistant", messageId: "summary", text: "Here are the findings" })).toBe(false);
    expect(f.event({ type: "message.completed", role: "assistant", messageId: "summary", text: "Which scope do you want?" })).toBe(false);
    f.event({ type: "turn.completed", turnId: "discussion", status: "success", durationMs: 1, resultText: "# Recommendations" });
    expect(f.list()).toEqual([]);
    plans.write(f.db, f.run, "legacy", "Ordinary discussion", "response", true, 1);
    expect(f.list()).toEqual([]);
    f.event({ type: "plan.updated", documentId: "native", text: "# Actual proposed plan", complete: true });
    const actual = f.list();
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({ source: "native", state: "ready" });
    f.event({ type: "turn.started", turnId: "follow-up" });
    f.event({ type: "message.completed", role: "assistant", messageId: "answer", text: "A clarification about the plan" });
    f.event({ type: "turn.completed", turnId: "follow-up", status: "success", durationMs: 1, resultText: "A clarification about the plan" });
    expect(f.list()).toEqual(actual);
  } finally {
    f.db.close();
  }
});
