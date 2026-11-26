import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AcpAdapter, ClaudeAdapter, CodexAdapter, PiAdapter, RunHandle } from "@openorc/agents";
import { claudeAccounts, projects, runs, settings, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { WORKSPACE_ID, isHarnessId, type RunSpec, type TaskButton, type ThreadChoice } from "@openorc/protocol";
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
/** Presses a button set not to send: what it added to the thread's message box, and the box's whole draft. */
async function unsent(task: string, buttonId: string) {
  const pressed = await call("tasks.runButton", { taskId: task, buttonId });
  if (!("draft" in pressed)) throw new Error(`${buttonId} sent its message.`);
  return pressed;
}
async function finished(threadId: string) {
  await vi.waitFor(() => expect(spec(threadId)).toBeTruthy());
  const { handle, spec: started } = session(threadId)!;
  handle.emit("event", { type: "turn.completed", runId: started.runId, ts: Date.now(), turnId: "1", durationMs: 1, status: "success", resultText: "Done." });
  await vi.waitFor(() => expect(core.runs.threadActivity(threadId)).toBe("idle"));
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "task-threads-test-")));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Threads\n");
  await commitAll(root, "Initial");
  dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), "task-threads-data-")));
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

it("keeps a task's new threads and buttons on its account while accounts are kept separate, and moves no conversation", async () => {
  // The task is on Personal, not the project's default, so staying there can't be told from falling to the default.
  const { work, personal, claude } = await accounts();
  const opened = await call("tasks.openThread", { taskId, choice: claude(personal) });
  await call("projects.updateSettings", {
    id: projectId,
    settings: { taskButtons: [start, { ...review, choice: claude(work) }, { ...start, id: "elsewhere", choice: claude(work) }] },
  });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  await finished(opened.id);
  await call("app.settings.set", { claudeAccountsSeparate: true });

  await expect(call("tasks.newThread", { taskId, choice: claude(work) })).rejects.toThrow("This task is on Personal, and Settings keeps Claude accounts separate, so its work stays there.");
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(opened.id);
  await expect(call("threads.switchClaudeAccount", { id: opened.id, claudeAccountId: work })).rejects.toThrow("Settings keeps Claude accounts separate, so a conversation stays on its account.");

  const side = await call("tasks.runButton", { taskId, buttonId: "review" });
  expect(threads.get(core.db, side.threadId)?.claudeAccountId).toBe(personal);
  await call("tasks.runButton", { taskId, buttonId: "elsewhere" });
  await vi.waitFor(() => expect(runs.listForThread(core.db, opened.id)).toHaveLength(2));
  expect(threads.get(core.db, opened.id)?.claudeAccountId).toBe(personal);
  expect(runs.listForThread(core.db, opened.id).at(-1)?.claudeAccountId).toBe(personal);
});

it("opens no first thread on another account for a task made in a conversation while accounts are kept separate", async () => {
  const { work, personal, claude } = await accounts();
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal, mode: "act", permissionMode: "trusted" });
  const fromChat = (title: string) => call("tasks.create", { projectId, threadId: conversation.id, title, spec: "Do it.", workspaceMode: "current" }).then((task) => task.id);
  const [chosen, inherited] = [await fromChat("From the chat"), await fromChat("Also from the chat")];
  await call("app.settings.set", { claudeAccountsSeparate: true });

  await expect(call("tasks.openThread", { taskId: chosen, choice: claude(work) })).rejects.toThrow("This task is on Personal, and Settings keeps Claude accounts separate, so its work stays there.");
  expect(tasks.get(core.db, chosen)?.executionThreadId).toBeNull();
  expect((await call("tasks.openThread", { taskId: chosen, choice: { ...claude(personal), effort: "low" } })).claudeAccountId).toBe(personal);
  // With no account chosen it takes the conversation's, not the project's default.
  expect(await call("tasks.openThread", { taskId: inherited, choice: { ...claude(), effort: "low" } })).toMatchObject({ claudeAccountId: personal, importedFrom: `task:${inherited}` });
});

it("opens a task's first thread and buttons' threads on the task's account, not an older task run's, while accounts are kept separate", async () => {
  const { work, personal, claude } = await accounts();
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal, mode: "act", permissionMode: "trusted" });
  /** A task saved from the conversation on Personal that last ran on Work, before tasks ran in threads. */
  const ranOnWork = async (title: string) => {
    const id = (await call("tasks.create", { projectId, threadId: conversation.id, title, spec: "Do it.", workspaceMode: "current" })).id;
    runs.insert(core.db, { id: crypto.randomUUID(), taskId: id, threadId: null, agent: "claude", model: "test-model", mode: "act", permissionMode: "trusted", claudeAccountId: work });
    return id;
  };
  const [opened, pressed] = [await ranOnWork("Opened"), await ranOnWork("Pressed")];
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [{ ...review, choice: claude() }] } });
  await call("app.settings.set", { claudeAccountsSeparate: true });

  expect(await call("tasks.openThread", { taskId: opened })).toMatchObject({ agent: "claude", claudeAccountId: personal });
  const side = await call("tasks.runButton", { taskId: pressed, buttonId: "review" });
  expect(threads.get(core.db, side.threadId)?.claudeAccountId).toBe(personal);
  await vi.waitFor(() => expect(runs.listForThread(core.db, side.threadId).at(-1)?.claudeAccountId).toBe(personal));
});

it.each(["claude", "codex"] as const)(
  "refuses a task's new %s threads and buttons while accounts are kept separate once the project stopped using its account, and starts them on the default with the setting off",
  async (agent) => {
    const { work, personal } = await accounts();
    const choice: ThreadChoice = { agent, model: "test-model", effort: "high" };
    const opened = await call("tasks.openThread", { taskId, choice });
    expect(opened).toMatchObject({ agent, claudeAccountId: work });
    await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, { ...review, choice }] } });
    await call("tasks.runButton", { taskId, buttonId: "start" });
    await finished(opened.id);
    const conversation = threads.insert(core.db, { projectId, title: "Chat", agent, model: "test-model", effort: "high", claudeAccountId: work, mode: "act", permissionMode: "trusted" });
    const fromChat = (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
    const first = { taskId: fromChat, choice: { ...choice, effort: "low" } };
    await call("projects.updateSettings", { id: projectId, settings: { claudeAccounts: { only: true, accountIds: [personal], defaultId: personal, autoSwitch: false } } });

    await call("app.settings.set", { claudeAccountsSeparate: true });
    const refusal = "This project doesn't use Work, and Settings keeps Claude accounts separate, so this can't start on another account.";
    await expect(call("tasks.newThread", { taskId })).rejects.toThrow(refusal);
    await expect(call("tasks.runButton", { taskId, buttonId: "review" })).rejects.toThrow(refusal);
    await expect(call("tasks.openThread", first)).rejects.toThrow(refusal);
    expect((await call("tasks.threads", { taskId })).map((link) => link.thread.id)).toEqual([opened.id]);
    expect(tasks.get(core.db, fromChat)?.executionThreadId).toBeNull();

    await call("app.settings.set", { claudeAccountsSeparate: false });
    const side = await call("tasks.runButton", { taskId, buttonId: "review" });
    expect(threads.get(core.db, side.threadId)).toMatchObject({ agent, claudeAccountId: personal });
    expect(await call("tasks.newThread", { taskId })).toMatchObject({ agent, claudeAccountId: personal });
    expect(await call("tasks.openThread", first)).toMatchObject({ agent, claudeAccountId: personal });
  },
);

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

  const opened = await unsent(taskId, "draft-start");
  expect(opened.message).toMatch(/^Implement this task\.\n\nTask: Edit labels as chips/);
  expect(tasks.get(core.db, taskId)?.executionThreadId).toBe(opened.threadId);
  expect(threads.get(core.db, opened.threadId)).toMatchObject({ draft: opened.draft, mode: "plan" });
  // Pressed again, it adds to what the box has.
  const again = await unsent(taskId, "draft-start");
  expect(again.threadId).toBe(opened.threadId);
  expect(again.draft).toBe(`${opened.draft}\n\n${again.message}`);
  expect(threads.get(core.db, opened.threadId)?.draft).toBe(again.draft);

  const side = await unsent(taskId, "draft-review");
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

  const busy = await unsent(taskId, "later");
  expect(threads.get(core.db, opened.id)).toMatchObject({ mode: "act", draft: `Check the tests too.\n\n${busy.message}` });
  await finished(opened.id);

  const idle = await unsent(taskId, "other");
  expect(idle.threadId).toBe(opened.id);
  expect(threads.get(core.db, opened.id)).toMatchObject({
    agent: "codex",
    model: "test-model",
    effort: "high",
    mode: "plan",
    permissionMode: "review",
    draft: `Check the tests too.\n\n${busy.message}\n\n${idle.message}`,
  });
});

it("opens a thread with a choice for a task made in a conversation: another account or effort starts a new thread, the same choice reuses the conversation", async () => {
  const { work, personal, claude } = await accounts();
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "claude", model: "test-model", effort: "high", claudeAccountId: work, mode: "act", permissionMode: "trusted" });
  const fromChat = async () => (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;

  const elsewhere = await call("tasks.openThread", { taskId: await fromChat(), choice: claude(personal) });
  expect(elsewhere.id).not.toBe(conversation.id);
  expect(elsewhere.claudeAccountId).toBe(personal);
  expect((await call("tasks.openThread", { taskId: await fromChat(), choice: { ...claude(work), effort: "low" } })).id).not.toBe(conversation.id);
  expect((await call("tasks.openThread", { taskId: await fromChat(), choice: claude(work) })).id).toBe(conversation.id);
  expect((await call("tasks.openThread", { taskId: await fromChat(), choice: claude() })).id).toBe(conversation.id);
});

it("adds an unsent button's message to the draft of the conversation the task came from", async () => {
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  threads.update(core.db, conversation.id, { draft: "Half a thought" });
  const fromChat = (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [{ ...start, autoSend: false }] } });

  const pressed = await unsent(fromChat, "start");
  expect(pressed.threadId).toBe(conversation.id);
  expect(threads.get(core.db, conversation.id)?.draft).toBe(`Half a thought\n\n${pressed.message}`);
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

it("carries the task's handoff in an unsent button's message when the press makes the task's thread", async () => {
  // A Codex conversation, which a button on a Claude model can't reuse.
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const fromChat = async () => (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
  const note: TaskButton = { ...start, id: "note", autoSend: false, choice: { agent: "claude", model: "test-model", effort: "high" } };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [note, { ...note, id: "bare", prompt: "Summarize your last change.", includeTask: false }] } });

  const pressed = await unsent(await fromChat(), "note");
  expect(pressed.threadId).not.toBe(conversation.id);
  expect(pressed.message).toMatch(/^Implement this task\.\n\nTask: From the chat \(.+\)\n\nDo it\.\n\nWork on task "From the chat"[\s\S]*\n\nHandoff:/);
  expect(pressed.draft).toBe(pressed.message);
  expect(threads.get(core.db, pressed.threadId)?.draft).toBe(pressed.draft);

  const bare = await unsent(await fromChat(), "bare");
  expect(bare.message).toBe("Summarize your last change.");
  expect(bare.draft).toMatch(/^Work on task "From the chat"[\s\S]*\n\nHandoff:[\s\S]*\n\nSummarize your last change\.$/);
  expect(threads.get(core.db, bare.threadId)?.draft).toBe(bare.draft);
});

it("leaves a new thread's handoff in its box when a button sends its prompt without the task, and clears it once one sends the task", async () => {
  const here: TaskButton = { ...start, id: "here", prompt: "Summarize your last change.", includeTask: false };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start, here] } });
  const work = await call("tasks.runButton", { taskId, buttonId: "start" });
  await finished(work.threadId);
  const fresh = await call("tasks.newThread", { taskId });
  expect(fresh.draft).toContain("Handoff:");

  await call("tasks.runButton", { taskId, buttonId: "here" });
  await vi.waitFor(() => expect(spec(fresh.id)?.prompt).toBe("Summarize your last change."));
  expect(threads.get(core.db, fresh.id)?.draft).toBe(fresh.draft);
  await finished(fresh.id);

  expect((await call("tasks.runButton", { taskId, buttonId: "start" })).threadId).toBe(fresh.id);
  expect(threads.get(core.db, fresh.id)?.draft).toBeNull();
});

it("writes an unsent button's skill calls for the task thread's own agent, whatever model the button chose", async () => {
  await call("tasks.openThread", { taskId, choice: { agent: "claude", model: "test-model", effort: "high" } });
  const greet: TaskButton = { ...start, id: "greet", prompt: "/say-hello then /src/app", autoSend: false, choice: { agent: "codex", model: "test-model", effort: "high" }, skills: ["say-hello"] };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [greet] } });

  const pressed = await unsent(taskId, "greet");
  expect(pressed.message).toMatch(/^\/say-hello then \/src\/app\n\nTask: Edit labels as chips/);
  expect(threads.get(core.db, pressed.threadId)).toMatchObject({ agent: "claude", draft: pressed.draft });
  expect(pressed.draft).toContain(`\n\n${pressed.message}`);
});

it("gives an idle thread of the same agent an unsent button's model and effort, keeping fast mode only on the same model", async () => {
  const opened = await call("tasks.openThread", { taskId, choice: { agent: "codex", model: "test-model", effort: "high" } });
  threads.update(core.db, opened.id, { fastMode: true });
  const later = (id: string, choice: ThreadChoice): TaskButton => ({ ...start, id, autoSend: false, choice });
  await call("projects.updateSettings", {
    id: projectId,
    settings: { taskButtons: [later("effort", { agent: "codex", model: "test-model", effort: "low" }), later("model", { agent: "codex", model: "other-model", effort: "high" })] },
  });

  await call("tasks.runButton", { taskId, buttonId: "effort" });
  expect(threads.get(core.db, opened.id)).toMatchObject({ model: "test-model", effort: "low", fastMode: true });
  await call("tasks.runButton", { taskId, buttonId: "model" });
  expect(threads.get(core.db, opened.id)).toMatchObject({ model: "other-model", effort: "high", fastMode: false });
});

it("carries a thread's mode to a new thread only when its agent can run it, and refuses a button's mode its agent can't run", async () => {
  const opened = await call("tasks.openThread", { taskId });
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start] } });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  await finished(opened.id);
  const side = (id: string, mode: TaskButton["mode"], agent: ThreadChoice["agent"]): TaskButton => ({ ...review, id, mode, autoSend: false, choice: { agent, model: "test-model", effort: "high" } });
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [side("opencode", "thread", "opencode"), side("fx", "plan", "fx")] } });

  // OpenCode can't run Accept edits, so its thread plans instead.
  threads.update(core.db, opened.id, { mode: "act", permissionMode: "trusted" });
  const planned = await call("tasks.runButton", { taskId, buttonId: "opencode" });
  expect(threads.get(core.db, planned.threadId)).toMatchObject({ agent: "opencode", mode: "plan", permissionMode: "review" });

  const listed = (await call("tasks.threads", { taskId })).length;
  await expect(call("tasks.runButton", { taskId, buttonId: "fx" })).rejects.toThrow("Review runs in Plan, which fx can't run. Change its Mode or Model in the project's settings.");
  expect(await call("tasks.threads", { taskId })).toHaveLength(listed);

  // fx has no Plan mode, so its thread takes Ask, which uses fx's saved permission rules and asks before changes.
  threads.update(core.db, opened.id, { mode: "plan", permissionMode: "review" });
  expect(await call("tasks.newThread", { taskId, choice: { agent: "fx", model: "test-model", effort: "high" } })).toMatchObject({ agent: "fx", mode: "act", permissionMode: "review" });
});

it("keeps a Workspace task's folder in its new threads, from Continue or a New thread button", async () => {
  // A Plan conversation, which a task's start can't reuse, so the task's thread is made from it.
  const conversation = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Chat", agent: "codex", model: null, mode: "plan", permissionMode: "review" });
  threads.update(core.db, conversation.id, { workingDirectory: root });
  const inFolder = (await call("tasks.create", { projectId: WORKSPACE_ID, threadId: conversation.id, title: "In the folder", spec: "Do it.", workspaceMode: "current" })).id;
  const work = await core.threads.runTaskButton(inFolder, start, []);
  expect(work.threadId).not.toBe(conversation.id);
  expect(threads.get(core.db, work.threadId)?.workingDirectory).toBe(root);
  await finished(work.threadId);

  const side = await core.threads.runTaskButton(inFolder, { ...review, autoSend: false }, []);
  expect(threads.get(core.db, side.threadId)?.workingDirectory).toBe(root);
  expect((await call("tasks.newThread", { taskId: inFolder })).workingDirectory).toBe(root);
});

it("opens a task's thread on a chosen agent in the mode it inherits only when that agent can run it", async () => {
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "claude", model: "test-model", effort: "high", mode: "act", permissionMode: "trusted" });
  const fromChat = (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
  // OpenCode can't run Accept edits.
  expect(await call("tasks.openThread", { taskId: fromChat, choice: { agent: "opencode", model: "test-model", effort: "high" } })).toMatchObject({
    agent: "opencode",
    mode: "plan",
    permissionMode: "review",
  });
});

it("leaves the thread's mode for an unsent button on Default, or on a mode the thread's agent can't run", async () => {
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "codex", model: null, mode: "plan", permissionMode: "review" });
  const fromChat = (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
  await call("projects.updateSettings", {
    id: projectId,
    settings: {
      taskButtons: [
        { ...start, autoSend: false },
        { ...start, id: "review-everything", mode: "review", autoSend: false },
      ],
    },
  });
  expect((await unsent(fromChat, "start")).threadId).toBe(conversation.id);
  expect(threads.get(core.db, conversation.id)).toMatchObject({ mode: "plan", permissionMode: "review" });

  const opened = await call("tasks.openThread", { taskId, choice: { agent: "opencode", model: "test-model", effort: "high" } });
  const pressed = await unsent(taskId, "review-everything");
  expect(threads.get(core.db, opened.id)).toMatchObject({ mode: opened.mode, permissionMode: opened.permissionMode, draft: pressed.draft });
});

it("keeps the task thread's Claude account for an unsent button that chose another", async () => {
  const { work, personal, claude } = await accounts();
  const opened = await call("tasks.openThread", { taskId, choice: claude(work) });
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [{ ...start, autoSend: false, choice: claude(personal) }] } });
  expect((await unsent(taskId, "start")).threadId).toBe(opened.id);
  expect(threads.get(core.db, opened.id)?.claudeAccountId).toBe(work);
});

it("runs a Default-mode New thread button pressed before the task has a thread in the mode that thread would get", async () => {
  const conversation = threads.insert(core.db, { projectId, title: "Chat", agent: "codex", model: null, mode: "plan", permissionMode: "review" });
  const fromChat = (await call("tasks.create", { projectId, threadId: conversation.id, title: "From the chat", spec: "Do it.", workspaceMode: "current" })).id;
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [{ ...review, mode: "thread" }] } });
  const side = await call("tasks.runButton", { taskId: fromChat, buttonId: "review" });
  expect(threads.get(core.db, side.threadId)?.mode).toBe("plan");
  await vi.waitFor(() => expect(spec(side.threadId)?.mode).toBe("plan"));
});

it("refuses a button on an archived task, making no thread for it", async () => {
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [review] } });
  tasks.update(core.db, taskId, { status: "archived" });
  await expect(call("tasks.runButton", { taskId, buttonId: "review" })).rejects.toThrow("Reopen this task before using its buttons.");
  expect(await call("tasks.threads", { taskId })).toEqual([]);
});

it("leaves a task in Review or Done where it is when a button runs in its thread", async () => {
  const check: TaskButton = { id: "check", label: "Check", prompt: "Check the work.", runsIn: "task", mode: "plan" };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [check] } });
  tasks.update(core.db, taskId, { status: "review" });
  const pressed = await call("tasks.runButton", { taskId, buttonId: "check" });
  await vi.waitFor(() => expect(spec(pressed.threadId)?.prompt).toMatch(/^Check the work\./));
  expect(tasks.get(core.db, taskId)?.status).toBe("review");

  const done = (await call("tasks.create", { projectId, title: "Chips everywhere", spec: "In comments too.", workspaceMode: "current" })).id;
  tasks.update(core.db, done, { status: "done", completedAt: 1_700_000_000_000 });
  await call("tasks.runButton", { taskId: done, buttonId: "check" });
  expect(tasks.get(core.db, done)).toMatchObject({ status: "done", completedAt: 1_700_000_000_000 });
});

it("removes a New thread button's thread when its message couldn't be sent, and opens an unsent one again instead of making another", async () => {
  const draftReview: TaskButton = { ...review, id: "draft-review", autoSend: false };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [review, draftReview] } });
  vi.spyOn(core.threads, "continueThread").mockRejectedValueOnce(new Error("Couldn't make the worktree."));
  await expect(call("tasks.runButton", { taskId, buttonId: "review" })).rejects.toThrow("Couldn't make the worktree.");
  expect(await call("tasks.threads", { taskId })).toEqual([]);

  const opened = await unsent(taskId, "draft-review");
  expect(await call("tasks.runButton", { taskId, buttonId: "draft-review" })).toEqual({ threadId: opened.threadId });
  threads.update(core.db, opened.threadId, { draft: "Review only the labels." });
  expect((await unsent(taskId, "draft-review")).threadId).not.toBe(opened.threadId);
  expect(await call("tasks.threads", { taskId })).toHaveLength(2);
});

it("continues in a new thread in the last thread's mode when the new thread's agent can run it", async () => {
  const opened = await call("tasks.openThread", { taskId });
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [start] } });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  await finished(opened.id);
  threads.update(core.db, opened.id, { mode: "act", permissionMode: "trusted" });

  const same = await call("tasks.newThread", { taskId });
  expect(same).toMatchObject({ agent: "codex", mode: "act", permissionMode: "trusted" });
  await call("tasks.runButton", { taskId, buttonId: "start" });
  await finished(same.id);
  expect(await call("tasks.newThread", { taskId, choice: { agent: "claude", model: "test-model", effort: "high" } })).toMatchObject({ agent: "claude", mode: "act", permissionMode: "trusted" });
});

it("keeps the model and account a person set on a task, and starts the task's threads on them unless what starts one names its own", async () => {
  const { personal, client, claude } = await accounts();
  await expect(call("tasks.update", { id: taskId, patch: { choice: claude(client) } })).rejects.toThrow("This project only uses these Claude accounts");
  expect((await call("tasks.update", { id: taskId, patch: { choice: claude(personal) } })).choice).toEqual(claude(personal));
  const draftStart: TaskButton = { ...start, id: "draft-start", autoSend: false };
  const draftReview: TaskButton = { ...review, id: "draft-review", autoSend: false };
  const codexReview: TaskButton = { ...draftReview, id: "codex-review", label: "Second review", choice: { agent: "codex", model: "test-model", effort: "high" } };
  await call("projects.updateSettings", { id: projectId, settings: { taskButtons: [draftStart, draftReview, codexReview] } });

  // A press that makes a thread and names no model takes the task's.
  const side = await unsent(taskId, "draft-review");
  expect(threads.get(core.db, side.threadId)).toMatchObject({ agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal });
  expect(threads.get(core.db, (await unsent(taskId, "codex-review")).threadId)).toMatchObject({ agent: "codex" });
  // So does the task's first thread.
  const opened = await call("tasks.openThread", { taskId });
  expect(opened).toMatchObject({ agent: "claude", model: "test-model", effort: "high", claudeAccountId: personal });

  // Changed afterwards, it is for the threads made from then: the task's own thread keeps the model it has.
  await call("tasks.update", { id: taskId, patch: { choice: { agent: "codex", model: "test-model", effort: "high" } } });
  expect((await unsent(taskId, "draft-start")).threadId).toBe(opened.id);
  expect(threads.get(core.db, opened.id)).toMatchObject({ agent: "claude", claudeAccountId: personal });
  expect((await call("tasks.update", { id: taskId, patch: { choice: null } })).choice).toBeNull();
  expect(sessions.size).toBe(0);
});
