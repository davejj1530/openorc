import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { runs, settings, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { CorePush, Project, RpcMethod, RpcParams, RpcResults, RunSpec } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let root: string, data: string, core: OpenOrc, project: Project;
let pushed: CorePush[], specs: RunSpec[], handles: RunHandle[];
let nextId = 0;
async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++nextId;
  await core.handle({ type: "rpc", id, method, params });
  const reply = pushed.find((item) => (item.type === "rpc.result" || item.type === "rpc.error") && item.id === id);
  if (reply?.type !== "rpc.result") throw new Error(reply?.type === "rpc.error" ? reply.message : "Missing reply");
  return reply.result as RpcResults[M];
}
async function mcp(runId: string, name: string, args: unknown) {
  const response = await fetch((await core.mcpServer()).urlForRun(runId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await response.text();
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
  );
  if (payload.result.isError) throw new Error(payload.result.content[0].text);
  return JSON.parse(payload.result.content[0].text);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "task-location-repo-")));
  data = await mkdtemp(path.join(os.tmpdir(), "task-location-data-"));
  await git(root, ["init", "-q", "-b", "user-branch"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await commitAll(root, "base");
  await writeFile(path.join(root, "tracked.txt"), "user dirty\n");
  await writeFile(path.join(root, "new.txt"), "user new\n");
  pushed = [];
  specs = [];
  handles = [];
  core = await OpenOrc.create({ dataDir: data, ephemeral: true, transport: { push: (event) => pushed.push(event) } });
  settings.set(core.db, "extraction.provider", "off");
  project = await core.projects.import(root);
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    specs.push(spec);
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, {
      send: async () => {},
      interrupt() {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      done,
    });
    handles.push(handle);
    return handle;
  });
});
afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});
function caller() {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Parent", agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
  const run = runs.insert(core.db, { id: `parent-${thread.id}`, threadId: thread.id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  return { thread, run };
}
describe("tasks stay in conversations", () => {
  it("keeps a backlog task's workspace editable while its creator works and starts it in its own worktree", async () => {
    const { thread } = await core.threads.start({
      projectId: project.id,
      agent: "codex",
      model: "fixture",
      effort: "high",
      mode: "act",
      permissionMode: "review",
      prompt: "Task A",
      attachments: [],
      title: "Creator",
      workspaceMode: "current",
    });
    const task = await call("tasks.create", { projectId: project.id, threadId: thread.id, title: "Task B", workspaceMode: "current" });
    const before = threads.list(core.db).length;
    await call("tasks.update", { id: task.id, patch: { workspaceMode: "worktree" } });
    expect(await call("tasks.executionThread", { taskId: task.id })).toBeNull();
    expect(threads.list(core.db)).toHaveLength(before);
    expect(tasks.get(core.db, task.id)?.worktreePath).toBeNull();
    const run = await call("tasks.start", { taskId: task.id });
    const assigned = await call("tasks.executionThread", { taskId: task.id });
    expect(assigned?.id).toBe(run.threadId);
    expect(assigned?.id).not.toBe(thread.id);
    expect(assigned?.workspaceMode).toBe("worktree");
    expect(tasks.get(core.db, task.id)?.threadId).toBe(thread.id);
    expect(tasks.list(core.db, { threadId: thread.id }).map((t) => t.id)).toContain(task.id);
    expect(tasks.list(core.db, { threadId: assigned!.id }).map((t) => t.id)).toContain(task.id);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("user dirty\n");
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("user new\n");
    expect(await realpath(specs[1]!.cwd)).toBe(await realpath(assigned!.worktreePath!));
  });

  it("reserves a creator once when sibling task starts arrive together", async () => {
    const creator = threads.insert(core.db, { projectId: project.id, title: "Creator", agent: "codex", model: "fixture", mode: "act", permissionMode: "review", workspaceMode: "current" });
    const a = await call("tasks.create", { projectId: project.id, threadId: creator.id, title: "A", workspaceMode: "current" });
    const b = await call("tasks.create", { projectId: project.id, threadId: creator.id, title: "B", workspaceMode: "current" });
    const launched = await Promise.all([call("tasks.start", { taskId: a.id }), call("tasks.start", { taskId: b.id })]);
    expect(launched[0].threadId).toBe(creator.id);
    expect(launched[1].threadId).not.toBe(creator.id);
    expect(specs).toHaveLength(2);
  });

  it("preserves an unrelated creator draft when starting a task there", async () => {
    const creator = threads.insert(core.db, { projectId: project.id, title: "Creator", agent: "codex", model: "fixture", mode: "act", permissionMode: "review", workspaceMode: "current" });
    threads.update(core.db, creator.id, { draft: "Unsent private instruction for later" });
    const task = await call("tasks.create", { projectId: project.id, threadId: creator.id, title: "Do this task", spec: "Only task work", workspaceMode: "current" });
    const run = await call("tasks.start", { taskId: task.id });
    expect(run.threadId).toBe(creator.id);
    expect(specs[0]?.prompt).toContain("Only task work");
    expect(specs[0]?.prompt).not.toContain("Unsent private instruction");
    expect(threads.get(core.db, creator.id)?.draft).toBe("Unsent private instruction for later");
  });

  it("starts task-screen work independently of a Plan-mode creator", async () => {
    const { thread: creator } = caller();
    const task = await call("tasks.create", { projectId: project.id, threadId: creator.id, title: "Implement", workspaceMode: "current" });
    const run = await call("tasks.start", { taskId: task.id });
    expect(run.threadId).not.toBe(creator.id);
    expect(run.mode).toBe("act");
    expect(tasks.get(core.db, task.id)?.executionThreadId).toBe(run.threadId);
    expect(threads.get(core.db, creator.id)?.mode).toBe("plan");
  });

  it.each(["fast mode", "workspace", "admission"] as const)("leaves execution unassigned when the first start fails at %s", async (phase) => {
    const creator = threads.insert(core.db, { projectId: project.id, title: "Creator", agent: "codex", model: "fixture", mode: "act", permissionMode: "review", workspaceMode: "current" });
    const task = await call("tasks.create", { projectId: project.id, threadId: creator.id, title: "Retry", workspaceMode: "current" });
    if (phase === "fast mode") vi.spyOn(core.runs, "validateFastMode").mockRejectedValueOnce(new Error("First start failed"));
    if (phase === "workspace") vi.spyOn(core.workspaces, "prepareThread").mockRejectedValueOnce(new Error("First start failed"));
    if (phase === "admission") vi.spyOn(core.runs, "start").mockRejectedValueOnce(new Error("First start failed"));
    await expect(call("tasks.start", { taskId: task.id })).rejects.toThrow("First start failed");
    expect(tasks.get(core.db, task.id)?.executionThreadId).toBeNull();
    expect(runs.listForThread(core.db, creator.id)).toEqual([]);
    await call("tasks.update", { id: task.id, patch: { workspaceMode: "worktree" } });
    const run = await call("tasks.start", { taskId: task.id });
    expect(run.threadId).not.toBe(creator.id);
    expect(threads.get(core.db, creator.id)?.workspaceMode).toBe("current");
  });

  it("preserves restored Astra Max settings through the next run", async () => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Old Astra selection", agent: "codex", model: "gpt-6-astra", effort: "max", mode: "act", permissionMode: "trusted" });
    const historical = runs.insert(core.db, { id: "historical-astra", threadId: thread.id, taskId: null, agent: "codex", model: "gpt-6-astra", effort: "max", mode: "act", permissionMode: "trusted" });
    runs.update(core.db, historical.id, { state: "success" });
    await call("threads.update", { id: thread.id, patch: { fastMode: false } });
    expect(threads.get(core.db, thread.id)?.effort).toBe("max");
    const run = await core.threads.continueThread(thread.id, {
      agent: "codex",
      model: "gpt-6-astra",
      effort: "max",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Continue",
      attachments: undefined,
    });
    expect(specs[0]?.effort).toBe("max");
    expect(run.effort).toBe("max");
    expect(runs.get(core.db, historical.id)?.effort).toBe("max");
  });

  it("moves a linked conversation both ways with its edits and reports the checkout branch", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Move conversation", workspaceMode: "current" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    const isolated = await call("threads.moveWorkspace", { id: thread.id, to: "worktree" });
    expect(isolated).toMatchObject({ workspaceMode: "worktree" });
    const moved = threads.get(core.db, thread.id)!;
    expect(await readFile(path.join(moved.worktreePath!, "new.txt"), "utf8")).toBe("user new\n");
    await call("threads.moveWorkspace", { id: thread.id, to: "current" });
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "current", worktreePath: null, branch: "user-branch" });
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("user dirty\n");
    expect((await call("tasks.openThread", { taskId: task.id })).id).toBe(thread.id);
    expect(specs).toEqual([]);
  });

  it("retains the linked workspace when a move is blocked by a checkout lock", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Locked", workspaceMode: "current" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    const lease = await core.workspaceWriters.acquire(root, "applying changes");
    try {
      await expect(call("threads.moveWorkspace", { id: thread.id, to: "worktree" })).rejects.toThrow(/in use/);
      expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "current", worktreePath: null });
      expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("user dirty\n");
    } finally {
      lease.release();
    }
  });

  it("changes an unprepared worktree conversation to local without reapplying checkout edits", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "No worktree yet", workspaceMode: "worktree" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    await call("threads.moveWorkspace", { id: thread.id, to: "current" });
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "current", worktreePath: null, branch: "user-branch" });
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("user dirty\n");
    expect(specs).toEqual([]);
  });

  it("restores the local selection after destination setup fails and allows retry", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Retry destination", workspaceMode: "current" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    const prepare = core.workspaces.prepareThread.bind(core.workspaces);
    vi.spyOn(core.workspaces, "prepareThread").mockImplementationOnce(async (...args) => {
      await prepare(...args);
      throw new Error("Destination setup failed");
    });
    await expect(call("threads.moveWorkspace", { id: thread.id, to: "worktree" })).rejects.toThrow("Destination setup failed");
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "current", worktreePath: null });
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("user dirty\n");
    await call("threads.moveWorkspace", { id: thread.id, to: "worktree" });
    expect(threads.get(core.db, thread.id)?.workspaceMode).toBe("worktree");
  });

  it("retains the worktree and its edits when the local checkout conflicts", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Conflicting checkout", workspaceMode: "current" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    await call("threads.moveWorkspace", { id: thread.id, to: "worktree" });
    const isolated = threads.get(core.db, thread.id)!;
    await writeFile(path.join(root, "tracked.txt"), "Separate checkout edit\n");
    await expect(call("threads.moveWorkspace", { id: thread.id, to: "current" })).rejects.toThrow();
    expect(threads.get(core.db, thread.id)?.worktreePath).toBe(isolated.worktreePath);
    expect(await readFile(path.join(isolated.worktreePath!, "tracked.txt"), "utf8")).toBe("user dirty\n");
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("Separate checkout edit\n");
  });

  it("updates an opened but unstarted task location without preparing files", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Linked", workspaceMode: "current" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    await call("tasks.update", { id: task.id, patch: { workspaceMode: "worktree" } });
    expect(tasks.get(core.db, task.id)).toMatchObject({ workspaceMode: "worktree", title: "Linked" });
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "worktree", worktreePath: null, baseSha: null });
    expect(specs).toHaveLength(0);
  });

  it("starts in the saved worktree choice and rejects a move while its run is active", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Isolate later", workspaceMode: "current" });
    await call("tasks.update", { id: task.id, patch: { workspaceMode: "worktree" } });
    await call("tasks.start", { taskId: task.id });
    const thread = threads.get(core.db, tasks.get(core.db, task.id)!.executionThreadId!)!;
    expect(thread.workspaceMode).toBe("worktree");
    expect(await realpath(specs[0]!.cwd)).toBe(await realpath(thread.worktreePath!));
    await expect(call("threads.moveWorkspace", { id: thread.id, to: "current" })).rejects.toThrow(/current turn/);
    expect(threads.get(core.db, thread.id)?.worktreePath).toBe(thread.worktreePath);
  });

  it("moves a legacy task's converted thread without moving its historical parent", async () => {
    const { thread: parent } = caller();
    const task = await call("tasks.create", { projectId: project.id, threadId: parent.id, title: "Legacy move", workspaceMode: "worktree" });
    const legacy = await core.threads.startTask(task, parent);
    await core.runs.closeAndWait(core.runs.liveRunForTask(task.id)!.id);
    const parentBeforeMove = threads.get(core.db, parent.id);
    await writeFile(path.join(legacy.worktreePath!, "legacy.txt"), "Keep the old task files\n");
    const owner = await call("tasks.openThread", { taskId: task.id });
    await call("threads.moveWorkspace", { id: owner.id, to: "current" });
    expect(owner.id).not.toBe(parent.id);
    expect(threads.get(core.db, parent.id)).toEqual(parentBeforeMove);
    expect(await readFile(path.join(root, "legacy.txt"), "utf8")).toBe("Keep the old task files\n");
    expect(await readFile(path.join(legacy.worktreePath!, "legacy.txt"), "utf8")).toBe("Keep the old task files\n");
    expect(specs).toHaveLength(1);
  });

  it("does not infer execution ownership from a diff base without run history", async () => {
    const { thread: parent } = caller();
    const task = await call("tasks.create", { projectId: project.id, threadId: parent.id, title: "Prepared local task", workspaceMode: "current" });
    const prepared = await core.workspaces.prepare(task, project);
    const owner = await call("tasks.openThread", { taskId: task.id });
    expect(prepared.baseSha).toBeTruthy();
    expect(core.threads.executionThreadFor(task.id)).toBeNull();
    expect(owner.id).toBe(parent.id);
    expect(threads.get(core.db, parent.id)).toEqual(parent);
    expect(specs).toEqual([]);
  });
  it("captures and starts work in the calling thread without spawning another provider or workspace", async () => {
    const { thread, run } = await core.threads.start({
      projectId: project.id,
      agent: "codex",
      model: "fixture",
      effort: undefined,
      mode: "act",
      permissionMode: "trusted",
      prompt: "Work here",
      attachments: [],
      title: "Parent",
      workspaceMode: "current",
    });
    core.settings.set({ defaultWorkspaceMode: "worktree" });
    const captured = await mcp(run.id, "task_create", { title: "Implement export", spec: "Preserve the current dirty files", execution: "delegate" });
    expect(captured).toMatchObject({ started: false, task: { status: "backlog" } });
    expect(tasks.get(core.db, captured.task.id)).toMatchObject({ threadId: thread.id, workspaceMode: "current", worktreePath: null });
    const started = await mcp(run.id, "task_start", { id: captured.task.id });
    expect(started).toMatchObject({ status: "in_progress", spec: "Preserve the current dirty files" });
    expect(started.message).toContain("in this conversation");
    expect(specs).toHaveLength(1);
    expect(runs.listForTask(core.db, captured.task.id)).toEqual([]);
    expect(core.runs.liveRunForThread(thread.id)?.id).toBe(run.id);
    expect((await call("tasks.openThread", { taskId: captured.task.id })).id).toBe(thread.id);
    await expect(mcp(run.id, "task_start", { id: captured.task.id, workspace_mode: "worktree" })).rejects.toThrow(/Move the thread/);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("user dirty\n");
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("user new\n");
    await mcp(run.id, "task_update", { id: captured.task.id, status: "done" });
    expect(tasks.get(core.db, captured.task.id)?.status).toBe("done");
    expect(threads.get(core.db, thread.id)?.doneAt).toBeNull();
  });

  it("opens one durable thread for an unlinked task without starting a provider", async () => {
    core.settings.set({ defaultWorkspaceMode: "worktree", defaultPermissionMode: "review" });
    const task = await call("tasks.create", { projectId: project.id, title: "Draft work", spec: "Keep this as a record" });
    expect(threads.list(core.db)).toEqual([]);
    expect(specs).toEqual([]);
    const opened = await call("tasks.openThread", { taskId: task.id });
    expect(opened).toMatchObject({ workspaceMode: "worktree", permissionMode: "review", worktreePath: null });
    expect(opened.draft).toContain(task.id);
    expect(opened.draft).toContain(task.spec);
    expect((await call("tasks.openThread", { taskId: task.id })).id).toBe(opened.id);
    expect(threads.list(core.db)).toHaveLength(1);
    expect(specs).toEqual([]);
    expect(tasks.get(core.db, task.id)).toMatchObject({ status: "backlog", threadId: null, executionThreadId: opened.id, worktreePath: null });
  });

  it("starts a thread opened from a task on the task's base branch when its first message is sent", async () => {
    await git(root, ["stash", "-u"]);
    await git(root, ["switch", "-q", "-c", "release"]);
    await writeFile(path.join(root, "release.txt"), "release only\n");
    await commitAll(root, "release work");
    await git(root, ["switch", "-q", "user-branch"]);
    const task = await call("tasks.create", { projectId: project.id, title: "Patch the release", workspaceMode: "worktree", baseRef: "release" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    await call("runs.start", { threadId: thread.id, agent: "codex", mode: "act", permissionMode: "trusted", prompt: "Go" });
    const worktree = threads.get(core.db, thread.id)!.worktreePath!;
    expect(await readFile(path.join(worktree, "release.txt"), "utf8")).toBe("release only\n");
  });

  it("starts an unlinked task as a thread run and preserves the chosen workspace and task ID", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Use local checkout", workspaceMode: "current" });
    const [run, repeated] = await Promise.all([call("tasks.start", { taskId: task.id }), call("tasks.start", { taskId: task.id })]);
    expect(run.id).toBe(repeated.id);
    expect(run.taskId).toBeNull();
    expect(run.threadId).toBe(tasks.get(core.db, task.id)?.executionThreadId);
    expect(runs.listForThread(core.db, run.threadId!)).toHaveLength(1);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.cwd).toBe(root);
    expect(specs[0]?.prompt).toContain(task.id);
  });

  it("does not bypass an exclusive checkout operation or fall back to a worktree", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "After apply", workspaceMode: "current" });
    const lease = await core.workspaceWriters.acquire(root, "applying checkout changes");
    try {
      await expect(call("tasks.start", { taskId: task.id })).rejects.toThrow(/in use by applying checkout changes/);
      expect(tasks.get(core.db, task.id)).toMatchObject({ workspaceMode: "current", worktreePath: null, status: "backlog" });
      expect(specs).toEqual([]);
    } finally {
      lease.release();
    }
  });

  it("resumes a completed task's review feedback in its existing conversation", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Reviewed task", workspaceMode: "current" });
    const thread = await call("tasks.openThread", { taskId: task.id });
    tasks.update(core.db, task.id, { status: "done" }, { explicitStatus: true });
    const review = { threadId: thread.id, taskId: task.id };
    const comment = await call("review.comments.add", {
      ...review,
      path: "tracked.txt",
      startLine: null,
      startSide: null,
      line: 1,
      side: "new",
      lineText: "user dirty",
      body: "Preserve this content",
    });
    const accepted = await call("review.comments.send", { ...review, commentIds: [comment.id] });
    expect(accepted).toEqual({ messageId: expect.any(String), sent: 1 });
    expect(await call("review.comments.send", { ...review, commentIds: [comment.id] })).toEqual(accepted);
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0]?.prompt).toContain(comment.body);
    expect(tasks.get(core.db, task.id)?.status).toBe("in_progress");
    expect((await call("review.comments.list", review))[0]?.sentMessageId).toBe(accepted.messageId);
    expect(threads.list(core.db)).toHaveLength(1);
  });

  it("opens legacy agents as threads and retains their workspaces through task deletion", async () => {
    const { thread } = caller();
    const task = await call("tasks.create", { projectId: project.id, threadId: thread.id, title: "Legacy isolated task", workspaceMode: "worktree" });
    const legacy = await core.threads.startTask(task, thread);
    await expect(call("tasks.openThread", { taskId: task.id })).rejects.toThrow(/Stop the existing task agent/);
    await core.runs.closeAndWait(core.runs.liveRunForTask(task.id)!.id);
    await writeFile(path.join(legacy.worktreePath!, "retained.txt"), "Legacy work\n");
    const opened = await call("tasks.openThread", { taskId: task.id });
    expect(opened.id).not.toBe(thread.id);
    expect(opened).toMatchObject({ worktreePath: legacy.worktreePath, branch: legacy.branch, forkedFromId: thread.id });
    expect((await call("tasks.openThread", { taskId: task.id })).id).toBe(opened.id);
    expect(runs.listForTask(core.db, task.id)).toHaveLength(1);
    expect(specs).toHaveLength(1);
    const { uncommitted, commits } = await call("workspace.removalImpact", { taskId: task.id });
    await call("tasks.delete", { id: task.id, deleteBranch: true, acceptLoss: { uncommitted, commits } });
    expect(await readFile(path.join(opened.worktreePath!, "retained.txt"), "utf8")).toBe("Legacy work\n");
    expect(threads.get(core.db, opened.id)?.worktreePath).toBe(opened.worktreePath);
  });

  it("keeps legacy task files when its new conversation is deleted", async () => {
    const { thread } = caller();
    const task = await call("tasks.create", { projectId: project.id, threadId: thread.id, title: "Retained history", workspaceMode: "worktree" });
    const legacy = await core.threads.startTask(task, thread);
    await core.runs.closeAndWait(core.runs.liveRunForTask(task.id)!.id);
    const opened = await call("tasks.openThread", { taskId: task.id });
    await call("threads.delete", { id: opened.id });
    expect(tasks.get(core.db, task.id)?.worktreePath).toBe(legacy.worktreePath);
    expect(await readFile(path.join(legacy.worktreePath!, "tracked.txt"), "utf8")).toBe("base\n");
    expect(await call("tasks.executionThread", { taskId: task.id })).toBeNull();
    expect(tasks.get(core.db, task.id)).toMatchObject({ threadId: thread.id, executionThreadId: null });
    const reopened = await call("tasks.openThread", { taskId: task.id });
    expect(reopened.id).not.toBe(opened.id);
    expect(reopened.worktreePath).toBe(legacy.worktreePath);
    const resumed = await call("tasks.start", { taskId: task.id });
    expect(resumed.threadId).toBe(reopened.id);
  });
});
