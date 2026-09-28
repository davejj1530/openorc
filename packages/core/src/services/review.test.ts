import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comments, Db, projects, runs, snapshots, tasks, threadQueue, threads } from "@openorc/db";
import { teamReviewComment, type ReviewComment, type Task, type Thread } from "@openorc/protocol";
import { ReviewService, type ReviewConversations } from "./review.js";

let db: Db;
let review: ReviewService;
let task: Task;
let sibling: Task;
let foreign: Task;

beforeEach(() => {
  db = Db.memory();
  review = new ReviewService(db);
  const project = (name: string) => projects.insert(db, { name, rootPath: `/tmp/review-${name}`, gitRemote: null, defaultBranch: "main", settings: {} });
  const makeTask = (projectId: string, title: string) =>
    tasks.insert(db, { projectId, title, spec: null, priority: "medium", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  const local = project("local");
  task = makeTask(local.id, "Selected review");
  sibling = makeTask(local.id, "Another task");
  foreign = makeTask(project("foreign").id, "Another project");
});

afterEach(() => {
  db.close();
});

function add(owner = task, patch: Partial<Pick<ReviewComment, "snapshotId" | "path" | "line" | "side" | "body">> = {}): ReviewComment {
  return comments.insert(db, {
    threadId: null,
    taskId: owner.id,
    snapshotId: null,
    path: "src/export.ts",
    startLine: null,
    startSide: null,
    line: 12,
    side: "new",
    lineText: null,
    body: "Keep the header.",
    ...patch,
  });
}

function snapshot(owner = task) {
  return snapshots.insert(db, { taskId: owner.id, runId: null, turn: 1, treeSha: `tree-${owner.id}`, diffStat: { files: 1, insertions: 1, deletions: 0, untracked: 0 } });
}

describe("selected review composition", () => {
  it("rejects empty selections and duplicate IDs instead of silently changing the requested batch", () => {
    const comment = add();
    expect(() => review.composeSelectedComments(task.id, [])).toThrow(/select|empty|at least/i);
    expect(() => review.composeSelectedComments(task.id, [comment.id, comment.id])).toThrow(/distinct|duplicate/i);
    expect(comments.listForTask(db, task.id)).toEqual([comment]);
  });

  it("rejects comments from a sibling task or another project", () => {
    const own = add();
    for (const owner of [sibling, foreign]) {
      const other = add(owner);
      expect(() => review.composeSelectedComments(task.id, [own.id, other.id])).toThrow(/comment.*(found|belong|available)/i);
      expect(comments.listForTask(db, owner.id)).toEqual([other]);
    }
    expect(comments.listForTask(db, task.id)).toEqual([own]);
  });

  it("rejects an already sent comment even when other selected comments remain unsent", () => {
    const pending = add();
    const sent = add(task, { body: "Already delivered." });
    const run = runs.insert(db, { id: "earlier-review", taskId: task.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    comments.markSent(db, [sent.id], run.id);
    expect(() => review.composeSelectedComments(task.id, [pending.id, sent.id])).toThrow(/already.*sent|already.*deliver/i);
    expect(comments.listForTask(db, task.id)).toEqual([pending, { ...sent, sentInRunId: run.id }]);
  });

  it("checks snapshot ownership independently of comment ownership", () => {
    for (const owner of [sibling, foreign]) {
      const otherSnapshot = snapshot(owner);
      const comment = add(task, { snapshotId: otherSnapshot.id });
      expect(() => review.composeSelectedComments(task.id, [comment.id])).toThrow(/snapshot.*(found|belong|available)/i);
    }
  });

  it("rejects a dangling snapshot reference and accepts an explicitly unanchored comment", () => {
    const source = snapshot();
    const comment = add(task, { snapshotId: source.id });
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.stmt("DELETE FROM snapshots WHERE id = ?").run(source.id);
    db.raw.exec("PRAGMA foreign_keys = ON");
    expect(() => review.composeSelectedComments(task.id, [comment.id])).toThrow(/snapshot.*(found|belong|available)/i);
    db.stmt("UPDATE review_comments SET snapshot_id = NULL WHERE id = ?").run(comment.id);
    expect(review.composeSelectedComments(task.id, [comment.id]).comments).toEqual([teamReviewComment({ ...comment, snapshotId: null })]);
  });

  it("rejects an absent task before composing any selection", () => {
    const comment = add();
    expect(() => review.composeSelectedComments("deleted-task", [comment.id])).toThrow(/task.*not found/i);
  });

  it("keeps a conversation comment out of team review even when it carries the task", () => {
    const thread = threads.insert(db, { projectId: task.projectId, title: "Conversation", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const labeled = comments.insert(db, {
      threadId: thread.id,
      taskId: task.id,
      snapshotId: null,
      path: "src/export.ts",
      startLine: null,
      startSide: null,
      line: 3,
      side: "new",
      lineText: "export {}",
      body: "Conversation note.",
    });
    expect(() => review.composeSelectedComments(task.id, [labeled.id])).toThrow(/not found on this task/i);
  });
});

describe("conversation review comments", () => {
  let conversation: Thread;
  let other: Thread;
  let queued: { threadId: string; text: string; requestKey: string }[];
  let conversations: ReviewConversations;

  beforeEach(() => {
    const thread = (title: string) => threads.insert(db, { projectId: task.projectId, title, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    conversation = thread("Works on the task");
    other = thread("Another conversation");
    task = tasks.update(db, task.id, { executionThreadId: conversation.id });
    queued = [];
    conversations = {
      executionThreadFor: (taskId) => {
        const id = tasks.get(db, taskId)?.executionThreadId ?? null;
        return id ? { id } : null;
      },
      queueFollowUp: vi.fn((input: { threadId: string; text: string; requestKey: string }) => {
        queued.push(input);
        return { messageId: threadQueue.enqueue(db, { ...input, attachments: [] }).id };
      }),
    };
    review = new ReviewService(db, undefined, undefined, { conversations });
  });

  const note = (scope: { threadId?: string; taskId?: string }, body = "Rename this.", line = 4) =>
    review.addComment({ ...scope, path: "src/export.ts", startLine: null, startSide: null, line, side: "new", lineText: `line ${line}`, body });

  it("keeps each conversation's comments separate and labels a task only in the conversation it works in", () => {
    const plain = note({ threadId: conversation.id });
    const labeled = note({ threadId: conversation.id, taskId: task.id }, "From the task screen.");
    const elsewhere = note({ threadId: other.id }, "Other conversation.");

    expect(review.comments({ threadId: conversation.id })).toEqual([plain, labeled]);
    expect(review.comments({ threadId: other.id })).toEqual([elsewhere]);
    expect(labeled).toMatchObject({ threadId: conversation.id, taskId: task.id, lineText: "line 4", snapshotId: null });
    expect(() => note({ threadId: other.id, taskId: task.id })).toThrow(/another conversation/i);
    expect(() => note({ threadId: conversation.id, taskId: sibling.id })).toThrow(/hasn't started/i);
    expect(() => note({ taskId: sibling.id })).toThrow(/team review/i);
    expect(() => review.removeComment({ threadId: other.id }, plain.id)).toThrow(/not found in this review/i);

    review.removeComment({ threadId: conversation.id }, plain.id);
    expect(review.comments({ threadId: conversation.id })).toEqual([labeled]);
  });

  it("queues the selected comments as one message and returns it again for the same selection", () => {
    const first = note({ threadId: conversation.id }, "First.", 4);
    const second = note({ threadId: conversation.id }, "Second.", 9);

    const sent = review.sendComments({ threadId: conversation.id, commentIds: [second.id, first.id] });
    expect(sent).toEqual({ messageId: expect.any(String), sent: 2, reopened: [] });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.threadId).toBe(conversation.id);
    expect(queued[0]!.text).toContain("src/export.ts:9\n   > line 9\n   Second.");
    expect(review.comments({ threadId: conversation.id }).map((comment) => comment.sentMessageId)).toEqual([sent.messageId, sent.messageId]);

    expect(review.sendComments({ threadId: conversation.id, commentIds: [first.id, second.id] })).toEqual(sent);
    expect(queued).toHaveLength(1);

    const later = note({ threadId: conversation.id }, "Later.");
    expect(() => review.sendComments({ threadId: conversation.id, commentIds: [first.id, later.id] })).toThrow(/already sent/i);
    expect(() => review.sendComments({ threadId: conversation.id, commentIds: [later.id, later.id] })).toThrow(/once/i);
    expect(comments.get(db, later.id)?.sentMessageId).toBeNull();
  });

  it("sends a task's earlier comments to its conversation and moves them there", () => {
    const earlier = add(task, { body: "Written before the task had a conversation." });
    expect(review.comments({ threadId: conversation.id })).toEqual([]);
    expect(review.comments({ threadId: conversation.id, taskId: task.id })).toEqual([earlier]);

    const { messageId } = review.sendComments({ threadId: conversation.id, taskId: task.id, commentIds: [earlier.id] });
    expect(comments.get(db, earlier.id)).toMatchObject({ threadId: conversation.id, taskId: task.id, sentMessageId: messageId });
    expect(() => review.sendComments({ threadId: other.id, taskId: task.id, commentIds: [earlier.id] })).toThrow(/another conversation/i);
  });

  it("stores a range and quotes each of its lines for the agent", () => {
    const range = (startSide: "old" | "new", side: "old" | "new", body: string, startLine = 3, line = 5) =>
      review.addComment({ threadId: conversation.id, path: "src/export.ts", startLine, startSide, line, side, lineText: "const a = 1;\nconst b = 2;\nconst c = 3;", body });
    const added = range("new", "new", "Merge these.");
    const removed = range("old", "old", "Why were these removed?");
    const across = range("old", "new", "Compare before and after.");
    const intoRemoved = range("new", "old", "Keep the removed line.", 2, 3);
    expect(comments.get(db, added.id)).toMatchObject({ startLine: 3, startSide: "new", line: 5, side: "new" });

    review.sendComments({ threadId: conversation.id, commentIds: [added.id, removed.id, across.id, intoRemoved.id] });
    const text = queued[0]!.text;
    expect(text).toContain("A line number marked - is a removed line, counted in the previous version");
    expect(text).toContain("1. src/export.ts:3-5\n   > const a = 1;\n   > const b = 2;\n   > const c = 3;\n   Merge these.");
    expect(text).toContain("2. src/export.ts:-3 to -5\n");
    expect(text).toContain("3. src/export.ts:-3 to +5\n");
    expect(text).toContain("4. src/export.ts:+2 to -3\n");
  });

  it("quotes only the first lines of a long range", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const long = review.addComment({ threadId: conversation.id, path: "src/export.ts", startLine: 1, startSide: "new", line: 25, side: "new", lineText: lines.join("\n"), body: "Split this." });
    review.sendComments({ threadId: conversation.id, commentIds: [long.id] });
    const text = queued[0]!.text;
    expect(text).toContain("1. src/export.ts:1-25\n");
    expect(text).toContain("   > line 20\n   > … 5 more lines\n   Split this.");
    expect(text).not.toContain("line 21");
    expect(text).not.toContain("marked -");
  });

  it("cannot send without the conversation queue", () => {
    const comment = note({ threadId: conversation.id });
    const detached = new ReviewService(db);
    expect(() => detached.sendComments({ threadId: conversation.id, commentIds: [comment.id] })).toThrow(/conversation queue/i);
    expect(comments.get(db, comment.id)?.sentMessageId).toBeNull();
  });

  it("returns comments to the review when their queued message is removed, and sends them again as a new message", () => {
    const comment = note({ threadId: conversation.id });
    const first = review.sendComments({ threadId: conversation.id, commentIds: [comment.id] });
    threadQueue.update(db, first.messageId, "cancelled");
    expect(review.comments({ threadId: conversation.id })).toEqual([comment]);

    const second = review.sendComments({ threadId: conversation.id, commentIds: [comment.id] });
    expect(second.messageId).not.toBe(first.messageId);
    expect(review.comments({ threadId: conversation.id })[0]?.sentMessageId).toBe(second.messageId);
    expect(threadQueue.list(db, conversation.id).map((message) => message.id)).toEqual([second.messageId]);
  });

  it("gives feedback to the tasks its comments were written from, whichever screen sends it", () => {
    const labeled = note({ threadId: conversation.id, taskId: task.id }, "From the task screen.");
    const later = note({ threadId: conversation.id, taskId: task.id }, "Written before archiving.");
    tasks.update(db, task.id, { status: "done" }, { explicitStatus: true });

    // Sent from the conversation's own review, without the task screen's label.
    expect(review.sendComments({ threadId: conversation.id, commentIds: [labeled.id] }).reopened).toEqual([task.id]);
    expect(tasks.get(db, task.id)?.status).toBe("in_progress");

    tasks.update(db, task.id, { status: "archived" }, { explicitStatus: true });
    expect(() => review.sendComments({ threadId: conversation.id, commentIds: [later.id] })).toThrow(/unarchive/i);
    expect(comments.get(db, later.id)?.sentMessageId).toBeNull();
  });

  it("keeps a task-only review away from conversation comments that carry the task", () => {
    const labeled = note({ threadId: conversation.id, taskId: task.id });
    expect(review.comments({ taskId: task.id })).toEqual([]);
    expect(() => review.removeComment({ taskId: task.id }, labeled.id)).toThrow(/team review/i);
    expect(review.comments({ threadId: conversation.id })).toEqual([labeled]);
  });
});

describe("reading a task's changes", () => {
  it("shows nothing for a worktree task that has no workspace yet, without preparing one", async () => {
    const project = projects.get(db, task.projectId)!;
    expect(await review.diff(task, project)).toEqual({ baseSha: null, patch: "", files: [], since: null });
    expect(await review.log(task, project)).toEqual([]);
    expect(tasks.get(db, task.id)).toEqual(task);
  });
});
