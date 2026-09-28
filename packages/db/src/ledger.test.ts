import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@openorc/protocol";
import { Db } from "./database.js";
import { LedgerWriter, listEvents } from "./ledger.js";
import { checkpoints } from "./checkpoints.js";
import { audit, projects, runs, tasks, threads } from "./repos.js";
import { schedules } from "./schedules.js";
import { messages } from "./search.js";
import { migrations } from "./schema.js";

function fixture() {
  const db = Db.memory();
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo", gitRemote: null, defaultBranch: "main", settings: {} });
  const task = tasks.insert(db, { projectId: project.id, title: "Add CSV export", spec: null, priority: "medium", labels: ["feature"], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  const run = runs.insert(db, { id: "run-1", taskId: task.id, threadId: null, agent: "codex", model: "gpt-5.6-sol", mode: "act", permissionMode: "trusted" });
  return { db, project, task, run };
}

describe("migrations", () => {
  it("applies every migration", () => {
    const db = Db.memory();
    expect(db.version).toBe(migrations.length);
  });

  it("upgrades existing conversations to Standard and preserves Fast across reopening", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openorc-fast-migration-"));
    const file = path.join(dir, "old.sqlite");
    const raw = new DatabaseSync(file);
    // Version 6 predates Fast mode. Keep the fixture fixed when new migrations ship.
    const preFastVersion = 6;
    for (const migration of migrations.slice(0, preFastVersion)) {
      if (typeof migration === "string") raw.exec(migration);
      else migration(raw);
    }
    raw.exec(`PRAGMA user_version = ${preFastVersion}`);
    const old = new Db(raw);
    const project = projects.insert(old, { name: "Existing", rootPath: dir, gitRemote: null, defaultBranch: null, settings: {} });
    old.stmt("INSERT INTO threads (id, project_id, title, agent, created_at, updated_at, last_activity_at) VALUES ('old-thread', ?, 'Existing conversation', 'codex', 1, 1, 1)").run(project.id);
    old.stmt("INSERT INTO runs (id, thread_id, agent, started_at) VALUES ('old-run', 'old-thread', 'codex', 1)").run();
    old.close();
    let db = Db.open(file);
    try {
      expect(threads.get(db, "old-thread")).toMatchObject({ title: "Existing conversation", fastMode: false });
      expect(runs.get(db, "old-run")?.fastMode).toBe(false);
      threads.update(db, "old-thread", { fastMode: true });
      db.close();
      db = Db.open(file);
      expect(threads.get(db, "old-thread")?.fastMode).toBe(true);
      expect(runs.get(db, "old-run")?.fastMode).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("threads", () => {
  it("includes legacy done threads in the active list, with pinned threads first", () => {
    const { db, project } = fixture();
    const base = { projectId: project.id, agent: "codex" as const, model: null, mode: "act" as const, permissionMode: "trusted" as const };
    const a = threads.insert(db, { ...base, title: "A" });
    const b = threads.insert(db, { ...base, title: "B" });
    const c = threads.insert(db, { ...base, title: "C" });
    threads.update(db, a.id, { pinnedAt: 1 });
    threads.update(db, b.id, { doneAt: 2 });
    threads.update(db, c.id, { archivedAt: 3 });
    const d = threads.insert(db, { ...base, title: "D" });
    db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(Date.now() + 1, d.id);
    expect(threads.list(db, { filter: "active" }).map((t) => t.title)).toEqual(["A", "D", "B"]);
    expect(threads.list(db, { filter: "done" }).map((t) => t.title)).toEqual(["B"]);
    expect(threads.list(db, { filter: "archived" }).map((t) => t.title)).toEqual(["C"]);
    expect(threads.list(db, { filter: "all" })).toHaveLength(4);
    expect(threads.list(db, { filter: "active", limit: 1, offset: 1 }).map((t) => t.title)).toEqual(["D"]);
    expect(threads.get(db, d.id)?.workspaceMode).toBe("current");
  });

  it("finds the same task under a different title when the spec says the same thing", () => {
    const { db, project } = fixture();
    const thread = threads.insert(db, { projectId: project.id, title: "T", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const spec = "Stream every row of the report to a CSV file, escape quotes and commas, add a header row, and cover it with a unit test.";
    tasks.insert(db, { projectId: project.id, title: "Write the CSV writer", spec, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null, threadId: thread.id });
    expect(
      tasks.findSimilarInThread(db, thread.id, "Implement CSV export", "Stream each row of the report to a CSV file, escaping quotes and commas, with a header row, and cover it with a unit test.")
        ?.title,
    ).toBe("Write the CSV writer");
    expect(tasks.findSimilarInThread(db, thread.id, "Add the settings page", "Build a settings screen with theme and notification toggles, persisted in SQLite.")).toBeNull();
  });
});

describe("search and checkpoints", () => {
  it("indexes what was said and finds it by prefix, joined to the thread", () => {
    const { db, project } = fixture();
    const thread = threads.insert(db, { projectId: project.id, title: "Export work", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const run = runs.insert(db, { id: "run-t", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const writer = new LedgerWriter(db, { flushMs: 1000 });
    writer.push({ type: "message.completed", runId: run.id, ts: 10, messageId: "u1", role: "user", text: "Please add pagination to the invoices table" });
    writer.push({ type: "message.completed", runId: run.id, ts: 11, messageId: "a1", role: "assistant", text: "Added a paginated query with a cursor." });
    writer.push({ type: "tool.completed", runId: run.id, ts: 12, toolCallId: "x", name: "shell", output: "pagination in tool output should not match", isError: false });
    writer.flush();
    const hits = messages.search(db, "paginat");
    expect(hits.map((h) => h.role).sort()).toEqual(["assistant", "user"]);
    expect(hits[0]?.threadTitle).toBe("Export work");
    expect(messages.search(db, "paginat", { projectId: "other" })).toEqual([]);
    expect(messages.search(db, "nothing here")).toEqual([]);
  });

  it("keeps one checkpoint per turn and reads them back in order", () => {
    const { db, project } = fixture();
    const thread = threads.insert(db, { projectId: project.id, title: "T", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const stat = { files: 1, insertions: 2, deletions: 0, untracked: 0 };
    const first = checkpoints.insert(db, { threadId: thread.id, runId: null, turn: 1, treeSha: "aaa", diffStat: stat });
    checkpoints.insert(db, { threadId: thread.id, runId: null, turn: 2, treeSha: "bbb", diffStat: stat });
    expect(checkpoints.listForThread(db, thread.id).map((c) => c.treeSha)).toEqual(["aaa", "bbb"]);
    expect(checkpoints.get(db, first.id)?.diffStat.insertions).toBe(2);
  });

  it("stores schedules and reports the ones that are due", () => {
    const { db, project } = fixture();
    const s = schedules.insert(db, {
      projectId: project.id,
      title: "Nightly review",
      prompt: "Review open PRs",
      agent: "codex",
      model: null,
      effort: null,
      mode: "plan",
      permissionMode: "trusted",
      workspaceMode: "worktree",
      everyMinutes: 60,
    });
    expect(schedules.due(db, Date.now())).toEqual([]);
    expect(schedules.due(db, Date.now() + 61 * 60_000).map((x) => x.id)).toEqual([s.id]);
    schedules.update(db, s.id, { enabled: false });
    expect(schedules.due(db, Date.now() + 61 * 60_000)).toEqual([]);
    expect(schedules.list(db, project.id)[0]?.enabled).toBe(false);
  });
});

describe("repos", () => {
  it("round-trips projects, tasks, and runs", () => {
    const { db, project, task, run } = fixture();
    expect(projects.get(db, project.id)?.settings.branchPrefix).toBe("openorc");
    expect(tasks.list(db, { projectId: project.id })).toHaveLength(1);
    const updated = tasks.update(db, task.id, { status: "in_progress", labels: ["feature", "export"] });
    expect(updated.status).toBe("in_progress");
    expect(updated.labels).toEqual(["feature", "export"]);
    runs.update(db, run.id, { state: "success", externalSessionId: "thread-9", endedAt: 1 });
    expect(runs.get(db, run.id)?.externalSessionId).toBe("thread-9");
    expect(runs.lastSession(db, { taskId: task.id }, "codex")).toBe("thread-9");
  });
});

describe("ledger", () => {
  it("writes events in order and reads them back without raw rows", () => {
    const { db, run } = fixture();
    const writer = new LedgerWriter(db, { flushMs: 1000 });
    const events: AgentEvent[] = [
      { type: "session.started", runId: run.id, ts: 1, agent: "codex", externalSessionId: "t", model: "m" },
      { type: "raw", runId: run.id, ts: 2, agent: "codex", payload: { method: "x" } },
      { type: "message.delta", runId: run.id, ts: 3, messageId: "m1", role: "assistant", text: "hel" },
      { type: "message.completed", runId: run.id, ts: 4, messageId: "m1", role: "assistant", text: "hello" },
    ];
    for (const ev of events) writer.push(ev);
    writer.flush();
    expect(writer.eventsWritten).toBe(4);
    const back = listEvents(db, run.id);
    expect(back.map((e) => e.type)).toEqual(["session.started", "message.delta", "message.completed"]);
    expect(listEvents(db, run.id, { includeRaw: true })).toHaveLength(4);
    expect(listEvents(db, run.id, { afterSeq: 3 })).toHaveLength(1);
  });

  it("reads only the kinds asked for and, when capped, the newest of them in order", () => {
    const { db, run } = fixture();
    const writer = new LedgerWriter(db, { flushMs: 1000 });
    for (let i = 1; i <= 6; i += 1) {
      writer.push({ type: "message.delta", runId: run.id, ts: i * 2, messageId: `m${i}`, role: "assistant", text: "x" });
      writer.push({ type: "message.completed", runId: run.id, ts: i * 2 + 1, messageId: `m${i}`, role: "assistant", text: `reply ${i}` });
    }
    writer.flush();
    const newest = listEvents(db, run.id, { kinds: ["message.completed"], newest: true, limit: 3 });
    expect(newest.map((e) => (e.type === "message.completed" ? e.text : e.type))).toEqual(["reply 4", "reply 5", "reply 6"]);
    expect(listEvents(db, run.id, { kinds: ["message.delta"] })).toHaveLength(6);
  });

  it("keeps each item's first streamed row and its finished row once a later row carries the content", () => {
    const { db, run } = fixture();
    const writer = new LedgerWriter(db, { flushMs: 1000, artifactThresholdBytes: 1024 });
    const events: AgentEvent[] = [
      { type: "message.delta", runId: run.id, ts: 1, messageId: "m1", role: "assistant", text: "" },
      { type: "thinking.delta", runId: run.id, ts: 2, messageId: "t1", text: "hmm" },
      { type: "thinking.delta", runId: run.id, ts: 3, messageId: "t1", text: "…" },
      { type: "tool.started", runId: run.id, ts: 4, toolCallId: "c1", name: "Bash", input: { command: "ls" }, parentToolCallId: null },
      { type: "tool.output.delta", runId: run.id, ts: 5, toolCallId: "c1", text: "a.txt" },
      { type: "tool.output.delta", runId: run.id, ts: 6, toolCallId: "c1", text: "b".repeat(2000) },
      { type: "message.delta", runId: run.id, ts: 7, messageId: "m1", role: "assistant", text: "Hel" },
      { type: "activity.updated", runId: run.id, ts: 8, activityId: "diff-1", label: "Changes", status: "running", text: "one" },
      { type: "activity.updated", runId: run.id, ts: 9, activityId: "diff-1", label: "Changes", status: "running", text: "one two" },
      { type: "activity.updated", runId: run.id, ts: 10, activityId: "diff-1", label: "Changes", status: "running", text: "one two three" },
      { type: "thinking.completed", runId: run.id, ts: 11, messageId: "t1", text: "hmm…" },
      { type: "tool.completed", runId: run.id, ts: 12, toolCallId: "c1", name: "Bash", output: "a.txt\n", isError: false },
      { type: "message.completed", runId: run.id, ts: 13, messageId: "m1", role: "assistant", text: "Hello" },
    ];
    for (const ev of events) writer.push(ev);
    writer.flush();
    // The message's first row keeps its place above the tool that ran while it streamed; the large tool fragment's artifact goes too.
    expect(listEvents(db, run.id).map((e) => e.ts)).toEqual([1, 2, 4, 5, 8, 10, 11, 12, 13]);
    expect((db.raw.prepare("SELECT COUNT(*) AS c FROM artifacts").get() as { c: number }).c).toBe(0);
  });

  it("keeps fragments whose completion does not carry the content, and those of items still streaming", () => {
    const { db, run } = fixture();
    const writer = new LedgerWriter(db, { flushMs: 1000 });
    const events: AgentEvent[] = [
      { type: "thinking.delta", runId: run.id, ts: 1, messageId: "t1", text: "hidden reasoning" },
      { type: "thinking.completed", runId: run.id, ts: 2, messageId: "t1" },
      { type: "tool.started", runId: run.id, ts: 3, toolCallId: "c1", name: "Bash", input: {}, parentToolCallId: null },
      { type: "tool.output.delta", runId: run.id, ts: 4, toolCallId: "c1", text: "streamed" },
      { type: "tool.completed", runId: run.id, ts: 5, toolCallId: "c1", name: "Bash", output: undefined, isError: false },
      { type: "message.delta", runId: run.id, ts: 6, messageId: "m2", role: "assistant", text: "still typing" },
    ];
    for (const ev of events) writer.push(ev);
    writer.flush();
    expect(listEvents(db, run.id).map((e) => e.type)).toEqual(["thinking.delta", "thinking.completed", "tool.started", "tool.output.delta", "tool.completed", "message.delta"]);
  });

  it("redacts secrets before writing", () => {
    const { db, run } = fixture();
    const writer = new LedgerWriter(db);
    writer.push({ type: "tool.completed", runId: run.id, ts: 1, toolCallId: "t", name: "shell", output: "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456", isError: false });
    writer.flush();
    const row = db.stmt("SELECT payload, redacted FROM events WHERE run_id = ?").get(run.id) as { payload: string; redacted: number };
    expect(row.redacted).toBe(1);
    expect(row.payload).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(row.payload).toContain("[redacted:");
  });

  it("redacts run results, run errors, and audit metadata", () => {
    const { db, run } = fixture();
    const token = "glpat-abcdefghij0123456789";
    runs.update(db, run.id, { resultText: `Pushed with ${token}`, error: `fatal: ${token} rejected` });
    audit.record(db, { actor: "agent", action: "task.update", resourceType: "task", resourceId: null, metadata: { patch: { spec: `GITLAB_TOKEN=${token}` }, password: "pw-9x" } });
    expect(runs.get(db, run.id)).toMatchObject({ resultText: "Pushed with [redacted:gitlab-token]", error: "fatal: [redacted:gitlab-token] rejected" });
    expect(JSON.parse((db.stmt("SELECT metadata FROM audit_events").get() as { metadata: string }).metadata)).toEqual({
      patch: { spec: "GITLAB_TOKEN=[redacted:gitlab-token]" },
      password: "[redacted:secret-field]",
    });
  });

  it("keeps secrets out of events, large payloads, and the search index", () => {
    const { db, run } = fixture();
    const secrets = ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12", "hunter2hunter2", "s3cr3t-db-pass", "glpat-abcdefghij0123456789"];
    const writer = new LedgerWriter(db, { artifactThresholdBytes: 2048 });
    // A token that starts a line used to hide behind the \n escape of the serialized event.
    writer.push({ type: "message.completed", runId: run.id, ts: 1, messageId: "m1", role: "user", text: `Use this token:\n${secrets[0]}\nDB_PASSWORD=${secrets[1]}` });
    writer.push({
      type: "tool.started",
      runId: run.id,
      ts: 2,
      toolCallId: "t1",
      name: "psql",
      input: { url: `postgres://admin:${secrets[2]}@db.internal/app`, password: "pw-9x" },
      parentToolCallId: null,
    });
    writer.push({ type: "tool.completed", runId: run.id, ts: 3, toolCallId: "t1", name: "psql", output: `${"row\n".repeat(600)}GITLAB_TOKEN=${secrets[3]}`, isError: false });
    writer.flush();

    const stored = [
      ...(db.stmt("SELECT payload AS text FROM events WHERE run_id = ?").all(run.id) as { text: string }[]),
      ...(db.stmt("SELECT content AS text FROM artifacts").all() as { text: string }[]),
      ...(db.stmt("SELECT text FROM messages_fts").all() as { text: string }[]),
    ].map((row) => row.text);
    expect(db.stmt("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 1 });
    for (const secret of [...secrets, "pw-9x"])
      expect(
        stored.filter((text) => text.includes(secret)),
        secret,
      ).toEqual([]);
    expect(messages.search(db, "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12")).toEqual([]);
    const [message, started] = listEvents(db, run.id);
    expect(message).toMatchObject({ text: "Use this token:\n[redacted:github-token]\nDB_PASSWORD=[redacted:secret-assignment]" });
    expect(started).toMatchObject({ input: { url: "postgres://admin:[redacted:url-credentials]@db.internal/app", password: "[redacted:secret-field]" } });
  });
});
