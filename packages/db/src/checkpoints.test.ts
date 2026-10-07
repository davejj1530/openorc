import { beforeEach, describe, expect, it } from "vitest";
import { checkpoints } from "./checkpoints.js";
import { Db } from "./database.js";
import { projects, runs, tasks, threads } from "./repos.js";
import { taskComments } from "./task-comments.js";

const root = "/repo";
const stat = { files: 1, insertions: 1, deletions: 0, untracked: 0 };
let db: Db;
let mine: string;
let theirs: string;
let taskId: string;

beforeEach(() => {
  db = Db.memory();
  const project = projects.insert(db, { name: "demo", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  const conversation = { projectId: project.id, agent: "codex" as const, model: null, mode: "act" as const, permissionMode: "trusted" as const };
  mine = threads.insert(db, { ...conversation, title: "Mine" }).id;
  theirs = threads.insert(db, { ...conversation, title: "Theirs" }).id;
  taskId = tasks.insert(db, { projectId: project.id, title: "A task", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null }).id;
});

const since = () => Date.now() - 1_000;
const later = () => Date.now() + 1_000;

describe("checkpoints.agentWorkSince", () => {
  it("sees another thread's turn checkpoint in the folder, but not its own, an older one, or one from another folder", () => {
    const run = runs.insert(db, { id: "run-theirs", taskId: null, threadId: theirs, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    checkpoints.insert(db, { threadId: mine, runId: "run-theirs", turn: 1, treeSha: "a".repeat(40), diffStat: stat, root });
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: since() })).toBe(false);
    checkpoints.insert(db, { threadId: theirs, runId: run.id, turn: 1, treeSha: "b".repeat(40), diffStat: stat, root: "/elsewhere" });
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: since() })).toBe(false);
    const turn = checkpoints.insert(db, { threadId: theirs, runId: run.id, turn: 2, treeSha: "c".repeat(40), diffStat: stat, root });
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: turn.createdAt + 1 })).toBe(false);
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: turn.createdAt })).toBe(true);
  });

  it("sees a run of another conversation that started in the folder since, never this thread's own or a comment run", () => {
    runs.insert(db, { id: "run-mine", taskId: null, threadId: mine, agent: "codex", model: null, mode: "act", permissionMode: "trusted", workingDirectory: root });
    const recipient = { agent: "codex" as const, model: "fixture", effort: null };
    const comment = taskComments.insert(db, { taskId, requestKey: "ask", body: "What next?", recipients: [recipient], replyTo: null, source: "comment", context: "" });
    const attempt = taskComments.addAttempt(db, comment, recipient);
    runs.insert(db, { id: "run-comment", taskId: null, threadId: null, commentTurnId: attempt.id, agent: "codex", model: null, mode: "plan", permissionMode: "review", workingDirectory: root });
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: since() })).toBe(false);
    runs.insert(db, { id: "run-theirs", taskId: null, threadId: theirs, agent: "codex", model: null, mode: "act", permissionMode: "trusted", workingDirectory: root });
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: later() })).toBe(false);
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: since() })).toBe(true);
  });

  it("sees a task run in the folder that was still going since, and ignores one that ended before", () => {
    runs.insert(db, { id: "run-task", taskId, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted", workingDirectory: root });
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: later() })).toBe(true);
    runs.update(db, "run-task", { state: "success", endedAt: Date.now() - 5_000 });
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: since() })).toBe(true);
    expect(checkpoints.agentWorkSince(db, { root, threadId: mine, since: later() })).toBe(false);
  });
});
