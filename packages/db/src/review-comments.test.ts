import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Db } from "./database.js";
import { comments, projects, tasks, threads } from "./repos.js";
import { threadQueue } from "./thread-queue.js";
import { conversationReviewCommentsMigration } from "./review-comments-schema.js";
import { migrations } from "./schema.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A ledger one step before review comments belonged to conversations. */
function ledgerBeforeConversationComments() {
  const folder = mkdtempSync(join(tmpdir(), "review-comment-migration-"));
  folders.push(folder);
  const file = join(folder, "ledger.sqlite");
  const raw = new DatabaseSync(file);
  const upgrade = migrations.indexOf(conversationReviewCommentsMigration);
  for (const migration of migrations.slice(0, upgrade)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
  raw.exec(`PRAGMA user_version = ${upgrade}`);
  raw.exec("PRAGMA foreign_keys = ON");
  return { file, db: new Db(raw), upgrade };
}

it("moves a task's comments to the conversation it runs in and keeps everything they recorded", () => {
  const { file, db, upgrade } = ledgerBeforeConversationComments();
  const project = projects.insert(db, { name: "Review", rootPath: "/tmp/review-migration", gitRemote: null, defaultBranch: "main", settings: {} });
  const conversation = threads.insert(db, { projectId: project.id, title: "Works on it", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const task = (title: string) =>
    tasks.insert(db, { projectId: project.id, title, spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: "main", parentTaskId: null, threadId: null, origin: "user" });
  const running = tasks.update(db, task("Running").id, { executionThreadId: conversation.id });
  const unassigned = task("Not started");
  const legacy = db.stmt("INSERT INTO review_comments (id, task_id, snapshot_id, path, line, side, body, sent_in_run_id, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?)");
  legacy.run("assigned-comment", running.id, "src/app.ts", 12, "old", "Keep the removed guard.", 1000);
  legacy.run("unassigned-comment", unassigned.id, "README.md", null, null, "Explain the setup.", 2000);
  expect(db.version).toBe(upgrade);
  db.close();

  const migrated = Db.open(file);
  try {
    expect(migrated.version).toBe(migrations.length);
    expect(comments.list(migrated, { threadId: conversation.id })).toEqual([
      {
        id: "assigned-comment",
        threadId: conversation.id,
        taskId: running.id,
        snapshotId: null,
        path: "src/app.ts",
        startLine: null,
        startSide: null,
        line: 12,
        side: "old",
        lineText: null,
        body: "Keep the removed guard.",
        sentInRunId: null,
        sentMessageId: null,
        createdAt: 1000,
      },
    ]);
    expect(comments.list(migrated, { taskId: unassigned.id })).toEqual([expect.objectContaining({ id: "unassigned-comment", threadId: null, taskId: unassigned.id, line: null })]);

    // A later comment can cover a range, stored the way a pull request review names one.
    const range = comments.insert(migrated, {
      threadId: conversation.id,
      taskId: null,
      snapshotId: null,
      path: "src/app.ts",
      startLine: 10,
      startSide: "old",
      line: 12,
      side: "new",
      lineText: "a\nb\nc",
      body: "Range.",
    });
    expect(comments.get(migrated, range.id)).toEqual(range);

    // A comment belongs somewhere, and it leaves with its conversation.
    expect(() => migrated.stmt("INSERT INTO review_comments (id, path, body, created_at) VALUES ('nowhere', 'a.ts', 'x', 1)").run()).toThrow(/CHECK/);
    migrated.stmt("DELETE FROM threads WHERE id = ?").run(conversation.id);
    expect(comments.get(migrated, "assigned-comment")).toBeNull();
    expect(comments.get(migrated, "unassigned-comment")).not.toBeNull();
  } finally {
    migrated.close();
  }
});

function conversationWithTask(db: Db) {
  const project = projects.insert(db, { name: "Review", rootPath: "/tmp/review-comments", gitRemote: null, defaultBranch: "main", settings: {} });
  const conversation = threads.insert(db, { projectId: project.id, title: "Works on it", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const task = tasks.insert(db, {
    projectId: project.id,
    title: "Task",
    spec: null,
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: "main",
    parentTaskId: null,
    threadId: null,
    origin: "user",
  });
  const note = (threadId: string | null, body: string) =>
    comments.insert(db, { threadId, taskId: task.id, snapshotId: null, path: "src/app.ts", startLine: null, startSide: null, line: 1, side: "new", lineText: null, body });
  return { conversation, task, note };
}

it("counts a comment as sent only while its queued message stands", () => {
  const db = Db.memory();
  try {
    const { conversation, note } = conversationWithTask(db);
    const comment = note(conversation.id, "Rename this.");
    const queue = (requestKey: string) => threadQueue.enqueue(db, { threadId: conversation.id, text: "Review comments", attachments: [], requestKey }).id;

    const first = queue("review:first");
    comments.markQueued(db, [comment.id], { threadId: conversation.id, messageId: first });
    // A live link never moves to a second message.
    comments.markQueued(db, [comment.id], { threadId: conversation.id, messageId: queue("review:duplicate") });
    expect(comments.get(db, comment.id)?.sentMessageId).toBe(first);

    threadQueue.update(db, first, "cancelled");
    expect(comments.get(db, comment.id)?.sentMessageId).toBeNull();
    const second = queue("review:second");
    comments.markQueued(db, [comment.id], { threadId: conversation.id, messageId: second });
    expect(comments.list(db, { threadId: conversation.id })).toEqual([{ ...comment, sentMessageId: second }]);
  } finally {
    db.close();
  }
});

it("keeps a conversation's comments when the task they carry is deleted", () => {
  const db = Db.memory();
  try {
    const { conversation, task, note } = conversationWithTask(db);
    const labeled = note(conversation.id, "Written from the task screen.");
    const team = note(null, "Team review feedback.");

    tasks.delete(db, task.id);
    expect(comments.list(db, { threadId: conversation.id })).toEqual([{ ...labeled, taskId: null }]);
    expect(comments.get(db, team.id)).toBeNull();
  } finally {
    db.close();
  }
});
