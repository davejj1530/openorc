import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, runs, scheduleFirings, schedules, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { harnessIds, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type Task } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
const pushed: CorePush[] = [];
let nextId = 1;

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = nextId++;
  await core.handle({ type: "rpc", id, method, params });
  const reply = pushed.find((m) => (m.type === "rpc.result" || m.type === "rpc.error") && m.id === id);
  if (!reply) throw new Error("no reply");
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return (reply as { result: RpcResults[M] }).result;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-core-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-core-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  await writeFile(path.join(root, ".env"), "API_URL=http://localhost\n");
  await writeFile(path.join(root, ".worktreeinclude"), ".env\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: (m) => pushed.push(m) } });
});

afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

it("reserves an update without admitting a schedule while asynchronous shutdown drains", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openorc-update-admission-"));
  const updating = await OpenOrc.create({ dataDir: directory, ephemeral: true, transport: { push() {} } });
  try {
    const project = projects.insert(updating.db, { name: "Update fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
    const schedule = updating.schedules.create({
      projectId: project.id,
      title: "Later work",
      prompt: "Check the project",
      agent: "codex",
      model: null,
      effort: null,
      mode: "plan",
      permissionMode: "trusted",
      workspaceMode: "current",
      everyMinutes: 30,
    });
    schedules.update(updating.db, schedule.id, { nextRunAt: Date.now() - 1000 });
    expect(updating.prepareForUpdate()).toBeNull();
    expect(() => updating.schedules.trigger(schedule.id, "racing-update")).toThrow("shutting down");
    await updating.schedules.tick();
    expect(scheduleFirings.list(updating.db, schedule.id)).toEqual([]);
    expect(threads.list(updating.db, { projectId: project.id })).toEqual([]);
  } finally {
    await updating.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe("core", () => {
  let project: Project;
  let task: Task;

  it("reads file citations from the selected thread or task workspace", async () => {
    const p = await call("projects.import", { rootPath: root });
    const thread = threads.insert(core.db, { projectId: p.id, title: "File citations", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    expect((await call("files.read", { scope: { kind: "thread", id: thread.id }, path: "README.md" })).content).toBe("# demo\n");
    const workspace = await mkdtemp(path.join(dataDir, "citation-worktree-"));
    await writeFile(path.join(workspace, "README.md"), "# worktree source\n");
    threads.update(core.db, thread.id, { worktreePath: workspace, workspaceMode: "worktree" });
    expect((await call("files.read", { scope: { kind: "thread", id: thread.id }, path: "README.md" })).content).toBe("# worktree source\n");
    await expect(call("files.read", { scope: { kind: "thread", id: thread.id }, path: path.join(root, "README.md") })).rejects.toThrow("outside");
    const task = await call("tasks.create", { projectId: p.id, title: "Preview source", useWorktree: false });
    expect((await call("files.read", { scope: { kind: "task", id: task.id }, path: "README.md" })).content).toBe("# demo\n");
    await expect(call("files.read", { scope: { kind: "thread", id: "missing-thread" }, path: "README.md" })).rejects.toThrow("not found");
  });

  it("loads terminal history beyond the default ledger page while respecting explicit limits", async () => {
    const p = await call("projects.import", { rootPath: root });
    const thread = threads.insert(core.db, { projectId: p.id, title: "Long transcript", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const run = runs.insert(core.db, { id: "long-history", threadId: thread.id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    for (let i = 0; i < 5001; i++) core.ledger.push({ type: "thinking.delta", runId: run.id, ts: i, messageId: "thinking", text: "." });
    core.ledger.push({ type: "session.completed", runId: run.id, ts: 5002, status: "error", durationMs: 5002 });
    const events = await call("events.listForRun", { runId: run.id });
    expect(events).toHaveLength(5002);
    expect(events.at(-1)?.type).toBe("session.completed");
    expect(await call("events.listForRun", { runId: run.id, limit: 10 })).toHaveLength(10);
  });

  it.each([
    ["current", "tasks.start"],
    ["worktree", "runs.start"],
  ] as const)("starts a backlog task in a thread at the selected %s location through %s", async (workspaceMode, method) => {
    const p = await call("projects.import", { rootPath: root });
    const t = await call("tasks.create", { projectId: p.id, title: `Forward to ${workspaceMode}`, spec: "Keep the task instructions attached to this run.", useWorktree: workspaceMode === "current" });
    await call("app.settings.set", { defaultPermissionMode: "review" });
    const before = await git(root, ["worktree", "list", "--porcelain"]);
    let handle!: RunHandle;
    const models = vi.spyOn(core.runs, "models").mockResolvedValue([]);
    const adapter = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
      let finish!: (code: number) => void;
      const done = new Promise<number>((resolve) => {
        finish = resolve;
      });
      handle = new RunHandle(spec.runId, {
        send: async () => {},
        interrupt() {},
        close() {
          handle.emit("exit", 0);
          finish(0);
        },
        done,
      });
      return handle;
    });
    let executionThreadId: string | null = null;
    try {
      const prompt = "Check the edge cases first.";
      const launch = () =>
        method === "tasks.start"
          ? call("tasks.start", { taskId: t.id, workspaceMode })
          : call("runs.start", { taskId: t.id, workspaceMode, agent: "codex", model: "fixture", effort: "high", permissionMode: "autonomous", mode: "act", prompt, attachments: ["/tmp/fixture.png"] });
      const [run, repeated] = await Promise.all([launch(), launch()]);
      expect(core.prepareForUpdate()).toMatch(/agent work/);
      executionThreadId = run.threadId;
      expect(repeated.id).toBe(run.id);
      expect(adapter).toHaveBeenCalledTimes(1);
      const started = await call("tasks.get", { id: t.id });
      expect(started).toMatchObject({ workspaceMode, status: "in_progress", threadId: null, executionThreadId: run.threadId });
      expect(run.taskId).toBeNull();
      const thread = await call("threads.get", { id: run.threadId! });
      if (method === "tasks.start") expect(run.permissionMode).toBe("review");
      expect(adapter.mock.calls[0]?.[0].cwd).toBe(await realpath(workspaceMode === "current" ? p.rootPath : thread!.worktreePath!));
      expect(adapter.mock.calls[0]?.[0].prompt).toContain(t.spec);
      if (method === "runs.start") {
        expect(adapter.mock.calls[0]?.[0].prompt).toContain(prompt);
        expect(adapter.mock.calls[0]?.[0]).toMatchObject({ model: "fixture", effort: "high", permissionMode: "autonomous", attachments: ["/tmp/fixture.png"] });
      }
      if (workspaceMode === "current") expect(await git(root, ["worktree", "list", "--porcelain"])).toEqual(before);
      else await access(thread!.worktreePath!);
      await expect(call("tasks.start", { taskId: t.id, workspaceMode: workspaceMode === "current" ? "worktree" : "current" })).rejects.toThrow(/workspace/);
    } finally {
      handle?.close();
      if (executionThreadId) await vi.waitFor(() => expect(core.runs.liveRunForThread(executionThreadId!)).toBeNull());
      models.mockRestore();
      adapter.mockRestore();
    }
  });

  it("saves user-created tasks to backlog in an act-mode thread without starting a run", async () => {
    const p = await call("projects.import", { rootPath: root });
    const parent = threads.insert(core.db, { projectId: p.id, title: "Working thread", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const created = await call("tasks.create", { projectId: p.id, threadId: parent.id, title: "An idea for later", useWorktree: true });
    expect(created.status).toBe("backlog");
    expect(created.worktreePath).toBeNull();
    expect(await call("runs.listForTask", { taskId: created.id })).toEqual([]);
    await call("tasks.update", { id: created.id, patch: { status: "done" } });
    const reopened = await call("tasks.update", { id: created.id, patch: { status: "backlog" } });
    expect(reopened.completedAt).toBeNull();
    await expect(call("tasks.create", { projectId: p.id, threadId: "missing", title: "Invalid parent", useWorktree: true })).rejects.toThrow(/parent thread/i);
  });

  it("announces readiness with the MCP port", () => {
    const ready = pushed.find((m) => m.type === "ready");
    expect(ready && ready.type === "ready" && ready.mcpPort).toBeGreaterThan(0);
  });

  it("imports a git repo as a project and detects config files", async () => {
    project = await call("projects.import", { rootPath: root });
    expect(project.name).toBe(path.basename(root));
    expect(project.defaultBranch).toBe("main");
    expect(project.settings.detectedConfigs).toContain(".worktreeinclude");
    expect(project.settings.worktreeInclude).toEqual([".env"]);
    expect(await call("projects.import", { rootPath: root })).toEqual(project);
    expect(pushed.some((m) => m.type === "invalidate" && m.keys.includes("projects"))).toBe(true);
  });

  it("creates a task and prepares an isolated worktree with the ignored file copied in", async () => {
    task = await call("tasks.create", { projectId: project.id, title: "Add CSV export", useWorktree: true });
    expect(task.status).toBe("backlog");
    expect(task.workspaceMode).toBe("worktree");
    expect(task.baseRef).toBe("main");

    const prepared = await call("tasks.prepareWorkspace", { taskId: task.id });
    expect(prepared.branch).toMatch(/^openorc\/add-csv-export-[0-9a-f]{6}$/);
    expect(prepared.worktreePath).toContain(path.join(dataDir, "worktrees"));
    expect(prepared.baseSha).toHaveLength(40);
    expect(prepared.status).toBe("in_progress");
    await access(prepared.worktreePath as string);
    expect(await readFile(path.join(prepared.worktreePath as string, ".env"), "utf8")).toBe("API_URL=http://localhost\n");
    expect(await readFile(path.join(prepared.worktreePath as string, "README.md"), "utf8")).toBe("# demo\n");

    // Idempotent: a second call returns the same workspace.
    const again = await call("tasks.prepareWorkspace", { taskId: task.id });
    expect(again.worktreePath).toBe(prepared.worktreePath);
    task = again;
  });

  it("reviews a diff, commits, and lists the log for the task branch", async () => {
    const wt = task.worktreePath as string;
    await writeFile(path.join(wt, "export.ts"), "export const csv = () => 'a,b';\n");
    const diff = await call("review.diff", { taskId: task.id });
    expect(diff.baseSha).toBe(task.baseSha);
    expect(diff.files).toEqual([{ path: "export.ts", status: "untracked", oldPath: null }]);
    expect(diff.patch).toContain("+export const csv");
    expect(await call("review.snapshots", { taskId: task.id })).toEqual([]);

    const { sha } = await call("review.commit", { taskId: task.id, message: "Add export" });
    expect(sha).toHaveLength(40);
    const log = await call("git.log", { taskId: task.id });
    expect(log.map((c) => c.subject)).toEqual(["Add export"]);
    expect((await call("review.diff", { taskId: task.id })).patch).toContain("+export const csv");
  });

  it("reads an unstarted task's changes without preparing its workspace", async () => {
    const p = await call("projects.import", { rootPath: root });
    const unstarted = await call("tasks.create", { projectId: p.id, title: "Not started yet", useWorktree: true });
    expect(unstarted).toMatchObject({ workspaceMode: "worktree", worktreePath: null, baseSha: null });
    const worktrees = await git(root, ["worktree", "list", "--porcelain"]);
    expect(await call("review.diff", { taskId: unstarted.id })).toEqual({ baseSha: null, patch: "", files: [], since: null });
    expect(await call("git.log", { taskId: unstarted.id })).toEqual([]);
    expect(await call("tasks.get", { id: unstarted.id })).toEqual(unstarted);
    expect(await git(root, ["worktree", "list", "--porcelain"])).toEqual(worktrees);
  });

  it("keeps a conversation's review comments and diffs a task since its last review", async () => {
    const wt = task.worktreePath as string;
    const conversation = threads.insert(core.db, { projectId: task.projectId, title: "Review conversation", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const review = { threadId: conversation.id };
    const c1 = await call("review.comments.add", {
      ...review,
      path: "export.ts",
      startLine: null,
      startSide: null,
      line: 1,
      side: "new",
      lineText: "export const csv = true;",
      body: "Quote the header row too.",
    });
    expect(await call("review.comments.list", review)).toEqual([c1]);

    // No snapshot exists yet (snapshots come from agent turns), so "since reviewed" falls back to the base diff.
    let reviewed = await call("review.markReviewed", { taskId: task.id });
    expect(reviewed.reviewedSnapshotId).toBeNull();
    expect((await call("review.diff", { taskId: task.id, sinceReviewed: true })).since).toBeNull();

    // Fake a snapshot of the current tree, then change a file: the interdiff shows only the new change.
    const { treeHash } = await import("@openorc/git");
    const snap = core.db.stmt("INSERT INTO snapshots (id, task_id, run_id, turn, tree_sha, diff_stat, created_at) VALUES (?, ?, NULL, 1, ?, '{}', ?)");
    snap.run("snap-1", task.id, await treeHash(wt), Date.now());
    reviewed = await call("review.markReviewed", { taskId: task.id });
    expect(reviewed.reviewedSnapshotId).toBe("snap-1");
    await writeFile(path.join(wt, "later.ts"), "export const later = true;\n");
    const since = await call("review.diff", { taskId: task.id, sinceReviewed: true });
    expect(since.since?.snapshotId).toBe("snap-1");
    expect(since.patch).toContain("later.ts");
    expect(since.patch).not.toContain("export.ts");
    await call("review.comments.remove", { ...review, id: c1.id });
    expect(await call("review.comments.list", review)).toEqual([]);
  });

  it("reports disk usage and cleans up a worktree, keeping the branch", async () => {
    const usage = await call("workspace.usage", { taskId: task.id });
    expect(usage.bytes).toBeGreaterThan(0);
    const cleaned = await call("workspace.cleanup", { taskId: task.id });
    expect(cleaned.worktreePath).toBeNull();
    expect(cleaned.branch).toMatch(/^openorc\//);
    // Re-preparing checks the existing branch out again.
    const again = await call("tasks.prepareWorkspace", { taskId: task.id });
    expect(again.worktreePath).not.toBeNull();
    expect(again.branch).toBe(cleaned.branch);
    task = again;
  });

  it("supports current-branch tasks without a worktree", async () => {
    const t = await call("tasks.create", { projectId: project.id, title: "Quick fix", useWorktree: false });
    const prepared = await call("tasks.prepareWorkspace", { taskId: t.id });
    expect(prepared.worktreePath).toBeNull();
    expect(prepared.baseSha).toHaveLength(40);
    expect(prepared.branch).toBe("main");
  });

  it("rejects unknown methods and bad params", async () => {
    await expect(call("tasks.create", { projectId: project.id, title: "", useWorktree: true })).rejects.toThrow(/invalid params/);
    await core.handle({ type: "rpc", id: 999, method: "nope", params: {} });
    expect(pushed.some((m) => m.type === "rpc.error" && m.id === 999)).toBe(true);
  });

  it("deletes a task with its worktree and branch once the branch's own commits are accepted as lost", async () => {
    const wt = task.worktreePath as string;
    const branch = task.branch as string;
    await expect(call("tasks.delete", { id: task.id, deleteBranch: true })).rejects.toThrow(/commits that no other branch, remote or tag has/);
    const { uncommitted, commits } = await call("workspace.removalImpact", { taskId: task.id });
    await call("tasks.delete", { id: task.id, deleteBranch: true, acceptLoss: { uncommitted, commits } });
    expect(await call("tasks.get", { id: task.id })).toBeNull();
    await expect(access(wt)).rejects.toThrow();
    const branches = (await git(root, ["branch", "--list", branch])).stdout.trim();
    expect(branches).toBe("");
  });

  it("reports system info without throwing", async () => {
    const info = await call("system.info", {});
    expect(info.dataDir).toBe(dataDir);
    expect(info.harnesses.map((row) => row.id)).toEqual(harnessIds);
  });
});
