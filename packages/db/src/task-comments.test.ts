import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { projects, tasks, runs } from "./repos.js";
import { taskComments } from "./task-comments.js";

it("upgrades existing runs, keeps comments outside execution history, and cascades task deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "comment-migration-")),
    file = join(dir, "test.sqlite");
  const raw = new DatabaseSync(file);
  // Build the preceding real schema to exercise the additive upgrade.
  for (const migration of migrations.slice(0, -1)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
  raw.exec(`PRAGMA user_version=${migrations.length - 1}`);
  raw.close();
  let db = Db.open(file);
  try {
    const project = projects.insert(db, { name: "Test", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} });
    const task = tasks.insert(db, {
      projectId: project.id,
      title: "Task",
      spec: "Original",
      priority: "none",
      labels: [],
      workspaceMode: "current",
      baseRef: "main",
      parentTaskId: null,
      threadId: null,
      origin: "user",
    });
    const recipient = { agent: "codex" as const, model: "test", effort: "high" };
    const comment = taskComments.insert(db, { taskId: task.id, requestKey: "once", body: "Question", recipients: [recipient], replyTo: null, source: "comment", context: "Original snapshot" });
    const attempt = taskComments.addAttempt(db, comment, recipient);
    expect(() => taskComments.addAttempt(db, comment, recipient)).toThrow();
    const run = runs.insert(db, { id: "comment-run", taskId: null, threadId: null, commentTurnId: attempt.id, agent: "codex", model: "test", mode: "plan", permissionMode: "review" });
    expect(run.commentTurnId).toBe(attempt.id);
    expect(runs.listForTask(db, task.id)).toEqual([]);
    expect(() => runs.insert(db, { id: "bad", taskId: task.id, threadId: null, commentTurnId: attempt.id, agent: "codex", model: "test", mode: "plan", permissionMode: "review" })).toThrow(
      "exactly one",
    );
    tasks.update(db, task.id, { spec: "Updated" });
    expect(taskComments.get(db, comment.id)?.context).toBe("Original snapshot");
    taskComments.update(db, attempt.id, { body: "Partial reply", state: "running", runId: run.id });
    db.close();
    db = Db.open(file);
    expect(taskComments.attempt(db, attempt.id)).toMatchObject({ body: "Partial reply", state: "running", runId: run.id });
    expect(taskComments.request(db, task.id, "once")?.id).toBe(comment.id);
    db.stmt("DELETE FROM tasks WHERE id=?").run(task.id);
    expect(taskComments.get(db, comment.id)).toBeNull();
    expect(runs.get(db, run.id)).toBeNull();
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects malformed stored comment recipients, attempt state and intent", () => {
  const db = Db.memory();
  try {
    const project = projects.insert(db, { name: "Comments", rootPath: "/tmp/comments-malformed", gitRemote: null, defaultBranch: "main", settings: {} });
    const task = tasks.insert(db, {
      projectId: project.id,
      title: "Task",
      spec: "Spec",
      priority: "none",
      labels: [],
      workspaceMode: "current",
      baseRef: null,
      parentTaskId: null,
      threadId: null,
      origin: "user",
    });
    const recipient = { agent: "codex" as const, model: "test", effort: null };
    const comment = taskComments.insert(db, { taskId: task.id, requestKey: "once", body: "Question", recipients: [recipient], replyTo: null, source: "comment", context: "Context" });
    const attempt = taskComments.addAttempt(db, comment, recipient);

    db.stmt("UPDATE task_comments SET recipients='[42]' WHERE id=?").run(comment.id);
    expect(() => taskComments.get(db, comment.id)).toThrow();
    db.stmt("UPDATE task_comments SET recipients=? WHERE id=?").run(JSON.stringify([recipient]), comment.id);
    db.stmt("UPDATE task_comment_attempts SET recipient='null' WHERE id=?").run(attempt.id);
    expect(() => taskComments.attempt(db, attempt.id)).toThrow();
    db.stmt("UPDATE task_comment_attempts SET recipient=?,state='unknown' WHERE id=?").run(JSON.stringify(recipient), attempt.id);
    expect(() => taskComments.attempt(db, attempt.id)).toThrow();
    db.stmt("UPDATE task_comment_attempts SET state='queued',intent='{}' WHERE id=?").run(attempt.id);
    expect(() => taskComments.attempt(db, attempt.id)).toThrow();
    db.stmt("UPDATE task_comment_attempts SET intent=NULL WHERE id=?").run(attempt.id);
    expect(taskComments.attempt(db, attempt.id)?.recipient).toEqual(recipient);
  } finally {
    db.close();
  }
});
