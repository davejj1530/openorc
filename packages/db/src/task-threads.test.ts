import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { projects, tasks, threads } from "./repos.js";
import { taskThreads } from "./task-threads.js";

it("lists a task's linked threads newest first, keeps a thread's first label, lists a thread under two tasks, and goes with either side", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-threads-"));
  const db = Db.open(join(dir, "test.sqlite"));
  try {
    const project = projects.insert(db, { name: "Test", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} });
    const insertTask = (title: string) =>
      tasks.insert(db, { projectId: project.id, title, spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: "main", parentTaskId: null, threadId: null, origin: "user" });
    const task = insertTask("Task");
    const other = insertTask("Other task");
    const thread = (title: string) => threads.insert(db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "review" });
    const work = thread("Work");
    const review = thread("Review");
    taskThreads.link(db, { taskId: task.id, threadId: work.id, label: null });
    taskThreads.link(db, { taskId: task.id, threadId: review.id, label: "Review" });
    taskThreads.link(db, { taskId: task.id, threadId: work.id, label: "Something else" });
    taskThreads.link(db, { taskId: other.id, threadId: work.id, label: null });
    expect(taskThreads.list(db, task.id).map((row) => [row.threadId, row.label])).toEqual([
      [review.id, "Review"],
      [work.id, null],
    ]);
    expect(taskThreads.list(db, other.id).map((row) => [row.threadId, row.label])).toEqual([[work.id, null]]);
    threads.delete(db, review.id);
    expect(taskThreads.list(db, task.id).map((row) => row.threadId)).toEqual([work.id]);
    tasks.delete(db, task.id);
    expect(taskThreads.list(db, other.id).map((row) => row.threadId)).toEqual([work.id]);
    threads.delete(db, work.id);
    expect(db.stmt("SELECT count(*) AS n FROM task_threads").get()?.n).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
