import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { taskExecutionMigration } from "./task-execution-schema.js";
import { audit, projects, runs, tasks, threads } from "./repos.js";
import { threadQueue } from "./thread-queue.js";

it("migrates actual task ownership without treating a viewed diff as execution", () => {
  const raw = new DatabaseSync(":memory:");
  const db = new Db(raw);
  try {
    for (const migration of migrations.slice(0, migrations.indexOf(taskExecutionMigration))) {
      if (typeof migration === "string") raw.exec(migration);
      else migration(raw);
    }
    const project = projects.insert(db, { name: "Fixture", rootPath: "/fixture", gitRemote: null, defaultBranch: "main", settings: {} });
    const creator = threads.insert(db, { projectId: project.id, title: "Creator", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    const make = (title: string) =>
      tasks.insert(db, { projectId: project.id, threadId: creator.id, title, spec: "Work", priority: "none", labels: [], workspaceMode: "current", baseRef: "main", parentTaskId: null });
    const backlog = make("Viewed only");
    tasks.update(db, backlog.id, { baseSha: "diff-base-only" });
    const active = make("Started with task_start");
    tasks.update(db, active.id, { status: "review" });
    const reset = make("Returned to backlog");
    audit.record(db, { actor: "agent", action: "task.start", resourceType: "task", resourceId: reset.id, metadata: { threadId: creator.id } });
    const legacy = make("Legacy worktree");
    tasks.update(db, legacy.id, { workspaceMode: "worktree", worktreePath: "/retained/worktree", baseSha: "base", branch: "feature" });
    runs.insert(db, { id: "legacy", taskId: legacy.id, threadId: null, agent: "claude", model: "legacy-model", mode: "act", permissionMode: "review" });

    taskExecutionMigration(raw);
    expect(tasks.get(db, backlog.id)).toMatchObject({ threadId: creator.id, executionThreadId: null, baseSha: "diff-base-only" });
    expect(tasks.get(db, active.id)?.executionThreadId).toBe(creator.id);
    expect(tasks.get(db, reset.id)?.executionThreadId).toBe(creator.id);
    const moved = tasks.get(db, legacy.id)!;
    expect(moved.threadId).toBe(creator.id);
    expect(moved.executionThreadId).not.toBe(creator.id);
    expect(threads.get(db, moved.executionThreadId!)).toMatchObject({ agent: "claude", model: "legacy-model", worktreePath: "/retained/worktree", branch: "feature", baseSha: "base" });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

it("keeps one queue receipt per request and retains interrupted delivery without replaying it", () => {
  const db = Db.memory();
  try {
    const project = projects.insert(db, { name: "Fixture", rootPath: "/fixture", gitRemote: null, defaultBranch: "main", settings: {} });
    const thread = threads.insert(db, { projectId: project.id, title: "Queue", agent: "codex", model: null, mode: "act", permissionMode: "review" });
    const input = { threadId: thread.id, text: "Review these lines", attachments: [], requestKey: "review:a,b" };
    const first = threadQueue.enqueue(db, input);
    expect(threadQueue.enqueue(db, input).id).toBe(first.id);
    expect(() => threadQueue.enqueue(db, { ...input, text: "Different" })).toThrow(/different content/);
    threadQueue.update(db, first.id, "delivering");
    threadQueue.recover(db);
    expect(threadQueue.list(db, thread.id)).toMatchObject([{ id: first.id, state: "interrupted", interrupted: true }]);
    expect(threadQueue.pendingThreads(db)).toEqual([]);
    threadQueue.update(db, first.id, "delivered");
    expect(threadQueue.enqueue(db, input).id).toBe(first.id);
    expect(threadQueue.list(db, thread.id)).toEqual([]);
  } finally {
    db.close();
  }
});

it("clears only the deleted execution link and keeps creator history and sibling assignments", () => {
  const db = Db.memory();
  try {
    const project = projects.insert(db, { name: "Fixture", rootPath: "/fixture", gitRemote: null, defaultBranch: "main", settings: {} });
    const makeThread = (title: string) => threads.insert(db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "review" });
    const creator = makeThread("Creator"),
      execution = makeThread("Execution");
    const make = (title: string) =>
      tasks.insert(db, { projectId: project.id, threadId: creator.id, title, spec: "", priority: "none", labels: [], workspaceMode: "current", baseRef: "main", parentTaskId: null });
    const a = make("A"),
      b = make("B");
    tasks.update(db, a.id, { executionThreadId: execution.id });
    tasks.update(db, b.id, { executionThreadId: creator.id });
    threads.delete(db, execution.id);
    expect(tasks.get(db, a.id)).toMatchObject({ threadId: creator.id, executionThreadId: null });
    expect(tasks.get(db, b.id)).toMatchObject({ threadId: creator.id, executionThreadId: creator.id });
  } finally {
    db.close();
  }
});
