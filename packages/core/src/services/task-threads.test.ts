import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AcpAdapter, ClaudeAdapter, CodexAdapter, PiAdapter, RunHandle } from "@openorc/agents";
import { claudeAccounts, projects, runs, settings, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { isHarnessId, type RunSpec, type TaskButton, type ThreadChoice } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
import { inheritedProbe } from "./shell-environment.js";

let root: string, dataRoot: string, core: OpenOrc, taskId: string, projectId: string;
const sessions = new Map<string, { spec: RunSpec; handle: RunHandle }>();
const call = rpcClient(() => core);
const review: TaskButton = { id: "review", label: "Review", prompt: "Review this task's changes and list any risks.", runsIn: "new", mode: "plan" };
const start: TaskButton = { id: "start", label: "Start", prompt: "Implement this task.", runsIn: "task", mode: "thread" };

const runOf = (runId: string) => core.db.stmt("SELECT thread_id FROM runs WHERE id = ?").get(runId)?.thread_id;
const session = (threadId: string) => [...sessions.values()].find((candidate) => runOf(candidate.spec.runId) === threadId);
const spec = (threadId: string) => session(threadId)?.spec;
async function finished(threadId: string) {
  await vi.waitFor(() => expect(spec(threadId)).toBeTruthy());
  const { handle, spec: started } = session(threadId)!;
  handle.emit("event", { type: "turn.completed", runId: started.runId, ts: Date.now(), turnId: "1", durationMs: 1, status: "success", resultText: "Done." });
  await vi.waitFor(() => expect(core.runs.threadActivity(threadId)).toBe("idle"));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "task-threads-test-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Threads\n");
  await commitAll(root, "Initial");
  dataRoot = await mkdtemp(path.join(tmpdir(), "task-threads-data-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  sessions.clear();
  const spawn = (started: RunSpec) => {
    let resolve!: (value: number) => void;
    const done = new Promise<number>((r) => (resolve = r));
    let closed = false;
    const handle = new RunHandle(started.runId, {
      send: async () => {},
      interrupt() {},
      close() {
        if (!closed) {
          closed = true;
          handle.emit("exit", 0);
          resolve(0);
        }
      },
      done,
    });
    sessions.set(started.runId, { spec: started, handle });
    return handle;
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(spawn);
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(spawn);
  vi.spyOn(AcpAdapter.prototype, "start").mockImplementation(spawn);
  vi.spyOn(PiAdapter.prototype, "start").mockImplementation(spawn);
  core = await OpenOrc.create({ dataDir: path.join(dataRoot, crypto.randomUUID()), shellProbe: inheritedProbe(), transport: { push: () => {} } });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) =>
    isHarnessId(agent) ? [{ agent, id: "test-model", label: "Test", isDefault: true, efforts: ["high"], defaultEffort: "high" }] : [],
  );
  projectId = (await call("projects.import", { rootPath: root })).id;
  taskId = (await call("tasks.create", { projectId, title: "Edit labels as chips", spec: "One at a time.", workspaceMode: "current" })).id;
});
afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
});

it("keeps a project's task buttons without reordering its projects, and refuses two with one id", async () => {
  const before = projects.get(core.db, projectId)!.updatedAt;
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, review] } });
  expect(projects.get(core.db, projectId)).toMatchObject({ updatedAt: before, settings: { taskButtons: [start, review] } });
  await expect(call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, { ...review, id: "start" }] } })).rejects.toThrow("its own id");
});

it("runs a button in the task's thread as Start does, and another in a separate thread in the same checkout", async () => {
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, review] } });

  const work = await call("tasks.runButton", { taskId, buttonId: "start" });
  expect(tasks.get(core.db, taskId)).toMatchObject({ status: "in_progress", executionThreadId: work.threadId });
  await vi.waitFor(() => expect(spec(work.threadId)?.prompt).toMatch(/^Implement this task\.\n\nTask: Edit labels as chips/));
  await finished(work.threadId);

  const side = await call("tasks.runButton", { taskId, buttonId: "review" });
  expect(side.threadId).not.toBe(work.threadId);
  expect(threads.get(core.db, side.threadId)).toMatchObject({ title: "Review: Edit labels as chips", mode: "plan", workspaceMode: "current" });
  await vi.waitFor(() => expect(spec(side.threadId)?.prompt).toMatch(/^Review this task's changes and list any risks\.\n\nTask: Edit labels as chips \(.+\)\n\nOne at a time\./));
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(work.threadId);
  expect((await call("tasks.threads", { taskId })).map((link) => [link.thread.id, link.label, link.current])).toEqual([
    [work.threadId, null, true],
    [side.threadId, "Review", false],
  ]);

  await expect(call("tasks.runButton", { taskId, buttonId: "gone" })).rejects.toThrow("removed from this project");
});

it("starts a fresh working thread from the task and a brief of the last one, keeping the last one listed", async () => {
  const opened = await call("tasks.openThread", { taskId });
  expect(await call("tasks.newThread", { taskId })).toMatchObject({ id: opened.id });

  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start] } });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  const busy = core.runs.threadActivity(opened.id);
  expect(busy).not.toBe("idle");
  await expect(call("tasks.newThread", { taskId })).rejects.toThrow("Wait for the task's thread to finish");
  await finished(opened.id);

  const fresh = await call("tasks.newThread", { taskId });
  expect(fresh.id).not.toBe(opened.id);
  expect(fresh).toMatchObject({ forkedFromId: null, importedFrom: `task:${taskId}`, workspaceMode: "current" });
  expect(fresh.draft).toContain('Work on task "Edit labels as chips"');
  expect(fresh.draft).toContain("Handoff:");
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(fresh.id);
  expect((await call("tasks.threads", { taskId })).map((link) => [link.thread.id, link.label, link.current])).toEqual([
    [fresh.id, null, true],
    [opened.id, null, false],
  ]);
});

/** A project that uses only Work and Personal, of the app's Work, Personal and Client accounts. */
async function accounts() {
  const [work, personal, client] = ["Work", "Personal", "Client"].map((name) => claudeAccounts.add(core.db, name).id) as [string, string, string];
  await call("projects.updateSettings", { id: projectId, settings: { claudeAccounts: { only: true, accountIds: [work, personal], defaultId: work, autoSwitch: false } } });
  const claude = (claudeAccountId?: string): ThreadChoice => ({ agent: "claude", model: "test-model", effort: "high", ...(claudeAccountId ? { claudeAccountId } : {}) });
  return { work, personal, client, claude };
}

it("runs a button on its own model and account, in a new thread or the task's, and refuses an account the project doesn't use", async () => {
  const { work, personal, client, claude } = await accounts();
  const opened = await call("tasks.openThread", { taskId });
  expect(opened).toMatchObject({ agent: "codex" });
  await call("projects.updateSettings", {
    id: projectId,
    settings: {
      taskButtons: [
        { ...review, choice: claude(personal) },
        { ...start, choice: claude() },
        { ...review, id: "elsewhere", choice: claude(client) },
      ],
    },
  });

  const side = await call("tasks.runButton", { taskId, buttonId: "review" });
  expect(threads.get(core.db, side.threadId)).toMatchObject({ agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal, mode: "plan" });
  await vi.waitFor(() => expect(spec(side.threadId)).toMatchObject({ agent: "claude", model: "test-model" }));

  const ran = await call("tasks.runButton", { taskId, buttonId: "start" });
  expect(ran.threadId).toBe(opened.id);
  await vi.waitFor(() => expect(spec(opened.id)).toMatchObject({ agent: "claude", model: "test-model" }));
  expect(threads.get(core.db, opened.id)).toMatchObject({ agent: "claude", effort: "high", claudeAccountId: work });
  expect(runs.listForThread(core.db, opened.id).at(-1)?.claudeAccountId).toBe(work);

  await expect(call("tasks.runButton", { taskId, buttonId: "elsewhere" })).rejects.toThrow(/^This project only uses these Claude accounts: (Work, Personal|Personal, Work)\.$/);
});

it("sends a button's skill calls the way the agent it runs on calls skills", async () => {
  const greet = (id: string, agent: ThreadChoice["agent"], runsIn: TaskButton["runsIn"]): TaskButton => ({
    id,
    label: "Greet",
    prompt: "/say-hello then /src/app",
    runsIn,
    mode: "thread",
    choice: { agent, model: "test-model", effort: "high" },
    skills: ["say-hello"],
  });
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [greet("work", "codex", "task"), greet("codex", "codex", "new"), greet("claude", "claude", "new")] } });

  const work = await call("tasks.runButton", { taskId, buttonId: "work" });
  await vi.waitFor(() => expect(spec(work.threadId)?.prompt).toMatch(/^\$say-hello then \/src\/app\n\nTask: Edit labels as chips/));
  const codex = await call("tasks.runButton", { taskId, buttonId: "codex" });
  await vi.waitFor(() => expect(spec(codex.threadId)?.prompt).toMatch(/^\$say-hello then \/src\/app\n\nTask: Edit labels as chips/));
  const claude = await call("tasks.runButton", { taskId, buttonId: "claude" });
  await vi.waitFor(() => expect(spec(claude.threadId)?.prompt).toMatch(/^\/say-hello then \/src\/app\n\nTask: Edit labels as chips/));
});

it("starts a task's first thread on a button's model and account", async () => {
  const { personal, claude } = await accounts();
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [{ ...start, choice: claude(personal) }] } });
  const { threadId } = await call("tasks.runButton", { taskId, buttonId: "start" });
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(threadId);
  expect(threads.get(core.db, threadId)).toMatchObject({ agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal });
  await vi.waitFor(() => expect(spec(threadId)?.prompt).toMatch(/^Implement this task\./));
});

it("opens a task's new thread on the model and account chosen, and opens an existing one as it is", async () => {
  const { personal, client, claude } = await accounts();
  await expect(call("tasks.openThread", { taskId, choice: claude(client) })).rejects.toThrow("This project only uses these Claude accounts");
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBeNull();

  const opened = await call("tasks.openThread", { taskId, choice: claude(personal) });
  expect(opened).toMatchObject({ agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal, importedFrom: `task:${taskId}` });
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(opened.id);
  const again = await call("tasks.openThread", { taskId, choice: { agent: "codex", model: "test-model", effort: null } });
  expect(again).toMatchObject({ id: opened.id, agent: "claude", claudeAccountId: personal });
});

it("continues in a new thread on the model and account chosen, and refuses an account the project doesn't use", async () => {
  const { personal, client, claude } = await accounts();
  const opened = await call("tasks.openThread", { taskId });
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start] } });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  await finished(opened.id);

  await expect(call("tasks.newThread", { taskId, choice: claude(client) })).rejects.toThrow("This project only uses these Claude accounts");
  const fresh = await call("tasks.newThread", { taskId, choice: claude(personal) });
  expect(fresh).toMatchObject({ agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal, forkedFromId: null, importedFrom: `task:${taskId}` });
  expect(fresh.draft).toContain("Handoff:");
  expect(threads.get(core.db, opened.id)).toMatchObject({ agent: "codex" });
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(fresh.id);
});

it("starts a task's first thread on the agent the person chose for new threads", async () => {
  await call("app.settings.set", { defaultHarness: "claude" });
  const opened = await call("tasks.openThread", { taskId });
  expect(opened.agent).toBe("claude");
});

it("sends a button's prompt alone when it leaves the task out", async () => {
  const side: TaskButton = { id: "bare", label: "Review", prompt: "/review current changes", runsIn: "new", mode: "plan", includeTask: false };
  const here: TaskButton = { ...start, id: "here", prompt: "Summarize your last change.", includeTask: false };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [side, here] } });
  const review = await call("tasks.runButton", { taskId, buttonId: "bare" });
  await vi.waitFor(() => expect(spec(review.threadId)?.prompt).toBe("/review current changes"));
  const work = await call("tasks.runButton", { taskId, buttonId: "here" });
  await vi.waitFor(() => expect(spec(work.threadId)?.prompt).toBe("Summarize your last change."));
});

it("opens a review button's thread in the worktree and branch the task's agent worked in", async () => {
  const worktreeTask = (await call("tasks.create", { projectId, title: "Chips in a worktree", spec: "Work in a worktree.", workspaceMode: "worktree" })).id;
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, review] } });
  const work = await call("tasks.runButton", { taskId: worktreeTask, buttonId: "start" });
  await vi.waitFor(() => expect(spec(work.threadId)).toBeTruthy(), { timeout: 10_000 });
  const working = threads.get(core.db, work.threadId)!;
  expect(working.worktreePath).toBeTruthy();
  expect(spec(work.threadId)!.cwd).toBe(working.worktreePath);
  await finished(work.threadId);

  const side = await call("tasks.runButton", { taskId: worktreeTask, buttonId: "review" });
  await vi.waitFor(() => expect(spec(side.threadId)).toBeTruthy(), { timeout: 10_000 });
  expect(threads.get(core.db, side.threadId)).toMatchObject({ worktreePath: working.worktreePath, branch: working.branch, baseSha: working.baseSha, forkedFromId: null });
  expect(spec(side.threadId)!.cwd).toBe(working.worktreePath);
});

it("leaves a button's message in the thread's message box when it is set not to send", async () => {
  const draftStart: TaskButton = { ...start, id: "draft-start", mode: "plan", autoSend: false };
  const draftReview: TaskButton = { ...review, id: "draft-review", autoSend: false };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [draftStart, draftReview] } });

  const opened = await call("tasks.runButton", { taskId, buttonId: "draft-start" });
  expect(opened.draft).toMatch(/^Implement this task\.\n\nTask: Edit labels as chips/);
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(opened.threadId);
  expect(threads.get(core.db, opened.threadId)).toMatchObject({ draft: opened.draft, mode: "plan" });
  // Pressed again, it adds to what the box has.
  const again = await call("tasks.runButton", { taskId, buttonId: "draft-start" });
  expect(again.threadId).toBe(opened.threadId);
  expect(threads.get(core.db, opened.threadId)?.draft).toBe(`${opened.draft}\n\n${again.draft}`);

  const side = await call("tasks.runButton", { taskId, buttonId: "draft-review" });
  expect(threads.get(core.db, side.threadId)).toMatchObject({ title: "Review: Edit labels as chips", mode: "plan", draft: side.draft });
  expect(sessions.size).toBe(0);
});

it("starts a new thread's first message on a session of its own, not the last thread's", async () => {
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start] } });
  const work = await call("tasks.runButton", { taskId, buttonId: "start" });
  await vi.waitFor(() => expect(spec(work.threadId)).toBeTruthy());
  const { handle, spec: first } = session(work.threadId)!;
  handle.emit("event", { type: "session.started", runId: first.runId, ts: Date.now(), externalSessionId: "work-session", agent: first.agent, model: first.model ?? null });
  await vi.waitFor(() => expect(runs.get(core.db, first.runId)?.externalSessionId).toBe("work-session"));
  await finished(work.threadId);

  const fresh = await call("tasks.newThread", { taskId });
  expect((await call("tasks.runButton", { taskId, buttonId: "start" })).threadId).toBe(fresh.id);
  await vi.waitFor(() => expect(spec(fresh.id)).toBeTruthy());
  expect(spec(fresh.id)!.prompt).toContain("Handoff:");
  expect(spec(fresh.id)!.resumeSessionId).toBeUndefined();
  expect(spec(fresh.id)!.forkSession).toBeFalsy();
});

it("continues in a new thread on the last thread's model and Claude account when none is chosen", async () => {
  const { personal, claude } = await accounts();
  const opened = await call("tasks.openThread", { taskId, choice: claude(personal) });
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start] } });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  await finished(opened.id);

  const fresh = await call("tasks.newThread", { taskId });
  expect(fresh.id).not.toBe(opened.id);
  expect(fresh).toMatchObject({ agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal });
});

it("runs a button on a Claude model with no account on the task thread's account, in a new thread or the task's", async () => {
  const { personal, claude } = await accounts();
  const opened = await call("tasks.openThread", { taskId, choice: claude(personal) });
  await call("projects.updateSettings", {
    id: projectId,
    settings: {
      taskButtons: [
        { ...review, choice: claude() },
        { ...start, choice: claude() },
      ],
    },
  });

  const side = await call("tasks.runButton", { taskId, buttonId: "review" });
  expect(threads.get(core.db, side.threadId)?.claudeAccountId).toBe(personal);
  const ran = await call("tasks.runButton", { taskId, buttonId: "start" });
  expect(ran.threadId).toBe(opened.id);
  await vi.waitFor(() => expect(spec(opened.id)).toBeTruthy());
  expect(threads.get(core.db, opened.id)?.claudeAccountId).toBe(personal);
  expect(runs.listForThread(core.db, opened.id).at(-1)?.claudeAccountId).toBe(personal);
});

it("continues a Worktree task in the work thread's worktree, and starts there", async () => {
  const worktreeTask = (await call("tasks.create", { projectId, title: "Chips in a worktree", spec: "Work in a worktree.", workspaceMode: "worktree" })).id;
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start] } });
  const work = await call("tasks.runButton", { taskId: worktreeTask, buttonId: "start" });
  await vi.waitFor(() => expect(spec(work.threadId)).toBeTruthy(), { timeout: 10_000 });
  await finished(work.threadId);
  const working = threads.get(core.db, work.threadId)!;

  const next = await call("tasks.newThread", { taskId: worktreeTask });
  expect(next).toMatchObject({ workspaceMode: "worktree", worktreePath: working.worktreePath, branch: working.branch, baseSha: working.baseSha, baseBranch: working.baseBranch });
  expect((await call("tasks.runButton", { taskId: worktreeTask, buttonId: "start" })).threadId).toBe(next.id);
  await vi.waitFor(() => expect(spec(next.id)).toBeTruthy(), { timeout: 10_000 });
  expect(spec(next.id)!.cwd).toBe(working.worktreePath);
});

it("works on the task's branch, in one folder, after the work thread's worktree was removed", async () => {
  const worktreeTask = (await call("tasks.create", { projectId, title: "Chips in a worktree", spec: "Work in a worktree.", workspaceMode: "worktree" })).id;
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, review] } });
  const work = await call("tasks.runButton", { taskId: worktreeTask, buttonId: "start" });
  await vi.waitFor(() => expect(spec(work.threadId)).toBeTruthy(), { timeout: 10_000 });
  await finished(work.threadId);
  const { branch, baseSha } = threads.get(core.db, work.threadId)!;
  // Cleaning up worktrees removes the folder; the branch, with the task's work, stays.
  const live = core.runs.liveRunForThread(work.threadId);
  if (live) await core.runs.closeAndWait(live.id);
  expect(await core.workspaces.cleanupThread(threads.get(core.db, work.threadId)!, projects.get(core.db, projectId)!)).toMatchObject({ worktreePath: null, branch });

  const side = await call("tasks.runButton", { taskId: worktreeTask, buttonId: "review" });
  await vi.waitFor(() => expect(spec(side.threadId)).toBeTruthy(), { timeout: 10_000 });
  const folder = spec(side.threadId)!.cwd;
  expect((await git(folder, ["branch", "--show-current"])).stdout.trim()).toBe(branch);
  expect(threads.get(core.db, side.threadId)).toMatchObject({ worktreePath: folder, branch, baseSha });
  await finished(side.threadId);

  const next = await call("tasks.newThread", { taskId: worktreeTask });
  expect(next).toMatchObject({ worktreePath: folder, branch, baseSha });
  await call("tasks.runButton", { taskId: worktreeTask, buttonId: "start" });
  await vi.waitFor(() => expect(spec(next.id)).toBeTruthy(), { timeout: 10_000 });
  expect(spec(next.id)!.cwd).toBe(folder);
});

it("leaves a busy thread's mode alone for an unsent button, and on an idle thread of another agent takes only the button's mode", async () => {
  const opened = await call("tasks.openThread", { taskId, choice: { agent: "codex", model: "test-model", effort: "high" } });
  const later: TaskButton = { ...start, id: "later", mode: "plan", autoSend: false };
  const other: TaskButton = { ...later, id: "other", choice: { agent: "claude", model: "claude-model", effort: "low" } };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, later, other] } });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  expect(core.runs.threadActivity(opened.id)).not.toBe("idle");
  threads.update(core.db, opened.id, { draft: "Check the tests too." });

  const busy = await call("tasks.runButton", { taskId, buttonId: "later" });
  expect(threads.get(core.db, opened.id)).toMatchObject({ mode: "act", draft: `Check the tests too.\n\n${busy.draft}` });
  await finished(opened.id);

  const idle = await call("tasks.runButton", { taskId, buttonId: "other" });
  expect(idle.threadId).toBe(opened.id);
  expect(threads.get(core.db, opened.id)).toMatchObject({
    agent: "codex",
    model: "test-model",
    effort: "high",
    mode: "plan",
    permissionMode: "review",
    draft: `Check the tests too.\n\n${busy.draft}\n\n${idle.draft}`,
  });
});

it("opens a thread with a choice for a task made in a conversation: another account starts a new thread, the same choice reuses the conversation", async () => {
  const { work, personal, claude } = await accounts();
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "claude", model: "test-model", effort: "high", claudeAccountId: work, mode: "act", permissionMode: "trusted" });
  const fromChat = async () => (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;

  const elsewhere = await call("tasks.openThread", { taskId: await fromChat(), choice: claude(personal) });
  expect(elsewhere.id).not.toBe(conversation.id);
  expect(elsewhere.claudeAccountId).toBe(personal);
  expect((await call("tasks.openThread", { taskId: await fromChat(), choice: claude(work) })).id).toBe(conversation.id);
  expect((await call("tasks.openThread", { taskId: await fromChat(), choice: claude() })).id).toBe(conversation.id);
});

it("adds an unsent button's message to the draft of the conversation the task came from", async () => {
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  threads.update(core.db, conversation.id, { draft: "Half a thought" });
  const fromChat = (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [{ ...start, autoSend: false }] } });

  const pressed = await call("tasks.runButton", { taskId: fromChat, buttonId: "start" });
  expect(pressed.threadId).toBe(conversation.id);
  expect(threads.get(core.db, conversation.id)?.draft).toBe(`Half a thought\n\n${pressed.draft}`);
});

it("keeps fast mode on only for the same agent and model", async () => {
  const opened = await call("tasks.openThread", { taskId, choice: { agent: "codex", model: "test-model", effort: "high" } });
  threads.update(core.db, opened.id, { fastMode: true });
  const side = (id: string, choice: ThreadChoice): TaskButton => ({ ...review, id, autoSend: false, choice });
  await call("projects.updateSettings", {
    id: projectId,
    settings: {
      taskButtons: [
        side("effort", { agent: "codex", model: "test-model", effort: "low" }),
        side("model", { agent: "codex", model: "other-model", effort: "high" }),
        side("agent", { agent: "claude", model: "test-model", effort: "high" }),
      ],
    },
  });
  const fast = async (buttonId: string) => threads.get(core.db, (await call("tasks.runButton", { taskId, buttonId })).threadId)?.fastMode;
  expect(await fast("effort")).toBe(true);
  expect(await fast("model")).toBe(false);
  expect(await fast("agent")).toBe(false);
});

it("starts a button pressed before the task has a thread on what its first thread would start on", async () => {
  // A plan-mode conversation, so the task's report waits there instead of starting a turn.
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "codex", model: null, mode: "plan", permissionMode: "review" });
  const fromChat = (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
  await core.threads.startTask(tasks.get(core.db, fromChat)!, { agent: "codex", model: "test-model", effort: "high", permissionMode: "trusted" });
  const earlier = runs.listForTask(core.db, fromChat).at(-1)!;
  await vi.waitFor(() => expect(sessions.has(earlier.id)).toBe(true));
  sessions.get(earlier.id)!.handle.emit("event", { type: "turn.completed", runId: earlier.id, ts: Date.now(), turnId: "1", durationMs: 1, status: "success", resultText: "Done." });
  await core.runs.closeAndWait(earlier.id);
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [{ ...review, mode: "thread", autoSend: false }] } });

  const side = await call("tasks.runButton", { taskId: fromChat, buttonId: "review" });
  const first = await call("tasks.openThread", { taskId: fromChat });
  expect(threads.get(core.db, side.threadId)).toMatchObject({ agent: "codex", model: "test-model", effort: "high", mode: "act", permissionMode: "trusted" });
  expect(first).toMatchObject({ agent: "codex", model: "test-model", effort: "high", permissionMode: "trusted" });
});

it("reads a button mode an earlier build saved as the task thread's", async () => {
  const opened = await call("tasks.openThread", { taskId });
  threads.update(core.db, opened.id, { permissionMode: "review" });
  projects.updateSettings(core.db, projectId, { taskButtons: [{ ...review, mode: "act", autoSend: false } as unknown as TaskButton] });

  const side = await call("tasks.runButton", { taskId, buttonId: "review" });
  expect(threads.get(core.db, side.threadId)).toMatchObject({ mode: "act", permissionMode: "review" });
});
