import { afterEach, describe, expect, it } from "vitest";
import { checkpoints } from "./checkpoints.js";
import { Db } from "./database.js";
import { listEvents, LedgerWriter } from "./ledger.js";
import { plans } from "./plans.js";
import { projects, runs, snapshots, tasks, threads } from "./repos.js";
import { messages } from "./search.js";
import { threadQueue } from "./thread-queue.js";
import { deleteThreadRows, readThreadRows, unclassifiedTables, writeThreadRows } from "./thread-rows.js";
import { usageHistory } from "./usage-history.js";

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
const ledger = () => {
  const db = Db.memory();
  open.push(db);
  return db;
};

describe("which tables a relocation carries", () => {
  it("classifies every table that references a thread, run or event", () => {
    expect(unclassifiedTables(ledger())).toEqual([]);
  });

  it("fails for a new table that names a thread", () => {
    const db = ledger();
    db.raw.exec("CREATE TABLE thread_notes (id TEXT PRIMARY KEY, thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE)");
    db.raw.exec("CREATE TABLE run_marks (id TEXT PRIMARY KEY, source_run_id TEXT)");
    expect(unclassifiedTables(db).sort()).toEqual(["run_marks", "thread_notes"]);
  });
});

/** A thread with a subagent child, runs, events with a stored payload, a queue, checkpoints, a plan, messages and a summary. */
function seed(db: Db, root: string, dataDir: string) {
  const project = projects.insert(db, { name: "App", rootPath: root, gitRemote: null, defaultBranch: null, settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Fix it", agent: "claude", model: null, mode: "act", permissionMode: "autonomous", workspaceMode: "worktree" });
  threads.update(db, thread.id, { worktreePath: `${root}/.wt/fix`, branch: "fix" });
  const child = threads.insert(db, { projectId: project.id, title: "Explore", agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
  threads.update(db, child.id, { parentThreadId: thread.id, parentRelation: "subagent" });
  const run = runs.insert(db, {
    id: `run-${thread.id}`,
    taskId: null,
    threadId: thread.id,
    agent: "claude",
    model: null,
    mode: "act",
    permissionMode: "autonomous",
    workingDirectory: `${root}/.wt/fix`,
  });
  const childRun = runs.insert(db, { id: `run-${child.id}`, taskId: null, threadId: child.id, agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
  const writer = new LedgerWriter(db, { flushMs: 60_000, artifactThresholdBytes: 200, previewBytes: 50 });
  writer.push({ type: "message.completed", runId: run.id, ts: 1, messageId: "m1", role: "user", text: "please fix the bug", attachments: [`${dataDir}/attachments/shot.png`] } as never);
  writer.push({ type: "message.completed", runId: run.id, ts: 2, messageId: "m2", role: "assistant", text: `done ${"x".repeat(400)}` } as never);
  writer.push({ type: "turn.completed", runId: run.id, ts: 3, turnId: "turn-1", status: "success", durationMs: 1, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.25 } });
  writer.push({ type: "message.completed", runId: childRun.id, ts: 4, messageId: "m3", role: "assistant", text: "found it" } as never);
  writer.flush();
  threadQueue.enqueue(db, { threadId: thread.id, text: "and the tests", attachments: [`${dataDir}/attachments/log.txt`], requestKey: "k1" });
  checkpoints.insert(db, { threadId: thread.id, runId: run.id, turn: 1, treeSha: "a".repeat(40), diffStat: { files: 1, additions: 2, deletions: 0 }, root: `${root}/.wt/fix` } as never);
  db.raw
    .prepare("INSERT INTO conversation_plans (id, thread_id, run_id, document_id, revision, text, state, source, updated_at) VALUES (?, ?, ?, 'doc', 1, 'Plan', 'ready', 'native', 5)")
    .run(`plan-${thread.id}`, thread.id, run.id);
  db.raw.prepare("INSERT INTO thread_messages (id, thread_id, role, text, created_at) VALUES (?, ?, 'system', 'Moved here', 6)").run(`note-${thread.id}`, thread.id);
  db.raw
    .prepare("INSERT INTO session_summaries (run_id, thread_id, project_id, request, work_done, outcome, open_items, model, created_at) VALUES (?, ?, ?, 'r', 'w', 'o', '[]', 'm', 7)")
    .run(run.id, thread.id, project.id);
  writer.close();
  return { project, thread, child, run, childRun };
}

const counts = (db: Db, threadId: string) => Object.fromEntries(Object.entries(readThreadRows(db, threadId).tables).map(([table, rows]) => [table, rows.length]));

describe("a thread's rows between two ledgers", () => {
  it("reads back on the other ledger as the source has them, at the target's paths", () => {
    const mac = ledger();
    const brain = ledger();
    const { thread, child, run } = seed(mac, "/Users/me/app", "/Users/me/data");
    // The brain's own events come first, so the thread's events cannot keep their ids.
    const other = seed(brain, "/brain/app", "/brain/data");
    const rows = JSON.parse(JSON.stringify(readThreadRows(mac, thread.id))) as ReturnType<typeof readThreadRows>;
    const taken = brain.transaction(() =>
      writeThreadRows(brain, rows, {
        projectId: other.project.id,
        paths: [
          { from: "/Users/me/app/.wt/fix", to: "/brain/data/worktrees/fix" },
          { from: "/Users/me/data", to: "/brain/data" },
        ],
      }),
    );
    expect(taken).toBe(true);
    const moved = threads.get(brain, thread.id)!;
    expect(moved).toMatchObject({ projectId: other.project.id, worktreePath: "/brain/data/worktrees/fix", title: "Fix it", branch: "fix" });
    expect(threads.get(brain, child.id)).toMatchObject({ parentThreadId: thread.id, parentRelation: "subagent" });
    expect(runs.listForThread(brain, thread.id).map((each) => [each.id, each.workingDirectory])).toEqual([[run.id, "/brain/data/worktrees/fix"]]);
    const events = listEvents(brain, run.id);
    expect(events.map((event) => event.type)).toEqual(["message.completed", "message.completed", "turn.completed"]);
    expect(events[0]).toMatchObject({ attachments: ["/brain/data/attachments/shot.png"] });
    // The long message was stored as an artifact on the Mac; its new event still reaches it.
    expect(events[1]).toMatchObject({ text: `done ${"x".repeat(400)}` });
    expect(threadQueue.list(brain, thread.id).map((entry) => entry.attachments)).toEqual([["/brain/data/attachments/log.txt"]]);
    expect(checkpoints.listForThread(brain, thread.id).map((each) => each.root)).toEqual(["/brain/data/worktrees/fix"]);
    expect(plans.list(brain, thread.id).map((plan) => plan.text)).toEqual(["Plan"]);
    expect(messages.search(brain, "fix bug").map((hit) => hit.threadId)).toContain(thread.id);
    expect(counts(brain, thread.id)).toEqual(counts(mac, thread.id));
    expect(usageHistory(brain, { boundaries: [0, 10] }).total).toMatchObject({ costUsd: 0.5, sessions: 2, inputTokens: 200 });
  });

  it("takes the same package twice as once", () => {
    const mac = ledger();
    const brain = ledger();
    const { thread } = seed(mac, "/a", "/d");
    const { project } = seed(brain, "/b", "/e");
    const rows = readThreadRows(mac, thread.id);
    const rewrite = { projectId: project.id, paths: [] };
    expect(brain.transaction(() => writeThreadRows(brain, rows, rewrite))).toBe(true);
    const once = counts(brain, thread.id);
    const searchRows = () => (brain.raw.prepare("SELECT COUNT(*) AS c FROM messages_fts").get() as { c: number }).c;
    const indexed = searchRows();
    expect(brain.transaction(() => writeThreadRows(brain, rows, rewrite))).toBe(false);
    expect(counts(brain, thread.id)).toEqual(once);
    expect(searchRows()).toBe(indexed);
  });

  it("deletes every row of the thread and its subagents, and nothing else", () => {
    const db = ledger();
    const first = seed(db, "/a", "/d");
    const second = seed(db, "/b", "/e");
    const before = counts(db, second.thread.id);
    db.transaction(() => deleteThreadRows(db, first.thread.id));
    expect(threads.get(db, first.thread.id)).toBeNull();
    expect(threads.get(db, first.child.id)).toBeNull();
    expect((db.raw.prepare("SELECT COUNT(*) AS c FROM events WHERE run_id IN (?, ?)").get(first.run.id, first.childRun.id) as { c: number }).c).toBe(0);
    expect((db.raw.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE run_id = ?").get(first.run.id) as { c: number }).c).toBe(0);
    expect(counts(db, second.thread.id)).toEqual(before);
    expect(usageHistory(db, { boundaries: [0, 10] }).total).toMatchObject({ costUsd: 0.25, sessions: 1, inputTokens: 100 });
  });
});

describe("a thread's tasks between two ledgers", () => {
  /** The thread's own task with a comment, a snapshot it was reviewed at, a run and a child; one it made that another thread works on. */
  function withTasks(db: Db, root: string, dataDir: string) {
    const seeded = seed(db, root, dataDir);
    const { project, thread, run } = seeded;
    const task = { projectId: project.id, spec: "s", priority: "none" as const, labels: [], workspaceMode: "worktree" as const, baseRef: null, parentTaskId: null };
    const own = tasks.insert(db, { ...task, title: "Own", threadId: thread.id });
    const child = tasks.insert(db, { ...task, title: "Child", threadId: thread.id, parentTaskId: own.id });
    const elsewhere = threads.insert(db, { projectId: project.id, title: "Worker", agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
    const handed = tasks.insert(db, { ...task, title: "Handed", threadId: thread.id });
    tasks.update(db, handed.id, { executionThreadId: elsewhere.id });
    db.raw.prepare("UPDATE runs SET task_id = ? WHERE id = ?").run(own.id, run.id);
    const snapshot = snapshots.insert(db, { taskId: own.id, runId: run.id, turn: 1, treeSha: "b".repeat(40), diffStat: { files: 1, additions: 1, deletions: 0 } } as never);
    tasks.update(db, own.id, { reviewedSnapshotId: snapshot.id, worktreePath: `${root}/.wt/fix` });
    db.raw
      .prepare("INSERT INTO task_comments (id, task_id, request_key, body, recipients, source, context, created_at) VALUES (?, ?, 'k', 'Looks good', '[]', 'user', '{}', 1)")
      .run(`comment-${own.id}`, own.id);
    return { ...seeded, own, child, handed, elsewhere, snapshot };
  }

  it("carries the tasks the thread works on, linked as before, and leaves the one another thread works on", () => {
    const mac = ledger();
    const brain = ledger();
    const sent = withTasks(mac, "/Users/me/app", "/Users/me/data");
    const { project } = seed(brain, "/brain/app", "/brain/data");
    const rows = JSON.parse(JSON.stringify(readThreadRows(mac, sent.thread.id))) as ReturnType<typeof readThreadRows>;
    brain.transaction(() => writeThreadRows(brain, rows, { projectId: project.id, paths: [{ from: "/Users/me/app/.wt/fix", to: "/brain/w/fix" }] }));
    expect(tasks.get(brain, sent.own.id)).toMatchObject({ projectId: project.id, threadId: sent.thread.id, reviewedSnapshotId: sent.snapshot.id, worktreePath: "/brain/w/fix" });
    expect(tasks.get(brain, sent.child.id)).toMatchObject({ parentTaskId: sent.own.id });
    expect(tasks.get(brain, sent.handed.id)).toBeNull();
    expect(runs.get(brain, sent.run.id)?.taskId).toBe(sent.own.id);
    expect(brain.raw.prepare("SELECT body FROM task_comments WHERE task_id = ?").all(sent.own.id)).toEqual([{ body: "Looks good" }]);
    expect(counts(brain, sent.thread.id)).toEqual(counts(mac, sent.thread.id));
  });

  it("deletes the tasks that left with the thread, and keeps the one another thread works on", () => {
    const db = ledger();
    const sent = withTasks(db, "/a", "/d");
    db.transaction(() => deleteThreadRows(db, sent.thread.id));
    expect([sent.own.id, sent.child.id].map((id) => tasks.get(db, id))).toEqual([null, null]);
    expect(db.raw.prepare("SELECT COUNT(*) AS c FROM task_comments").get()).toEqual({ c: 0 });
    expect(tasks.get(db, sent.handed.id)).toMatchObject({ threadId: null, executionThreadId: sent.elsewhere.id });
  });
});
