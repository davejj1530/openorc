import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { insertLegacyThread } from "./fixtures/legacy-thread.js";
import { audit, projects, tasks, threads } from "./repos.js";
import { migrations } from "./schema.js";
import { taskExecutionMigration } from "./task-execution-schema.js";
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
    const creator = insertLegacyThread(db, { projectId: project.id, title: "Creator", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    const make = (title: string) => {
      const id = randomUUID();
      raw
        .prepare("INSERT INTO tasks (id,project_id,thread_id,title,spec,workspace_mode,base_ref,created_at,updated_at) VALUES (?,?,?,?,?,'current','main',1,1)")
        .run(id, project.id, creator.id, title, "Work");
      return { id };
    };
    const backlog = make("Viewed only");
    raw.prepare("UPDATE tasks SET base_sha='diff-base-only' WHERE id=?").run(backlog.id);
    const active = make("Started with task_start");
    raw.prepare("UPDATE tasks SET status='review' WHERE id=?").run(active.id);
    const reset = make("Returned to backlog");
    audit.record(db, { actor: "agent", action: "task.start", resourceType: "task", resourceId: reset.id, metadata: { threadId: creator.id } });
    const legacy = make("Legacy worktree");
    raw.prepare("UPDATE tasks SET workspace_mode='worktree',worktree_path='/retained/worktree',base_sha='base',branch='feature' WHERE id=?").run(legacy.id);
    insertLegacyRun(db, { id: "legacy", taskId: legacy.id, threadId: null, agent: "claude", model: "legacy-model", mode: "act", permissionMode: "review" });

    taskExecutionMigration(raw);
    const readTask = (id: string) => raw.prepare("SELECT thread_id,execution_thread_id,base_sha FROM tasks WHERE id=?").get(id)!;
    expect(readTask(backlog.id)).toMatchObject({ thread_id: creator.id, execution_thread_id: null, base_sha: "diff-base-only" });
    expect(readTask(active.id).execution_thread_id).toBe(creator.id);
    expect(readTask(reset.id).execution_thread_id).toBe(creator.id);
    const moved = readTask(legacy.id);
    expect(moved.thread_id).toBe(creator.id);
    expect(moved.execution_thread_id).not.toBe(creator.id);
    expect(raw.prepare("SELECT agent,model,worktree_path,branch,base_sha FROM threads WHERE id=?").get(moved.execution_thread_id!)).toMatchObject({
      agent: "claude",
      model: "legacy-model",
      worktree_path: "/retained/worktree",
      branch: "feature",
      base_sha: "base",
    });
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
