import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, runs, scheduleFirings, schedules, taskThreads, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { WORKSPACE_ID, harnessIds, type CorePush, type Project, type Task } from "@openorc/protocol";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
const pushed: CorePush[] = [];

const call = rpcClient(() => core);

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
    expect(await call("files.read", { scope: { kind: "project", id: p.id }, path: "README.md" })).toMatchObject({ kind: "file", text: "# demo\n" });
    expect(await call("files.search", { scope: { kind: "project", id: p.id }, query: "worktree-only" })).toEqual([]);
    expect(await call("files.read", { scope: { kind: "thread", id: thread.id }, path: "README.md" })).toMatchObject({ kind: "file", text: "# demo\n" });
    const workspace = await mkdtemp(path.join(dataDir, "citation-worktree-"));
    await writeFile(path.join(workspace, "README.md"), "# worktree source\n");
    await writeFile(path.join(workspace, "worktree-only.ts"), "export const worktree = true;\n");
    threads.update(core.db, thread.id, { worktreePath: workspace, workspaceMode: "worktree" });
    expect(await call("files.read", { scope: { kind: "thread", id: thread.id }, path: "README.md" })).toMatchObject({ kind: "file", text: "# worktree source\n" });
    expect(await call("files.search", { scope: { kind: "thread", id: thread.id }, query: "worktree-only" })).toEqual(["worktree-only.ts"]);
    expect(await call("files.search", { scope: { kind: "project", id: p.id }, query: "worktree-only" })).toEqual([]);
    await expect(call("files.read", { scope: { kind: "project", id: p.id, workingDirectory: workspace }, path: "README.md" })).rejects.toThrow("Only Workspace");
    expect(await call("files.read", { scope: { kind: "project", id: WORKSPACE_ID, workingDirectory: workspace }, path: "README.md" })).toMatchObject({ kind: "file", text: "# worktree source\n" });
    expect(await call("files.search", { scope: { kind: "project", id: WORKSPACE_ID, workingDirectory: workspace }, query: "worktree-only" })).toEqual(["worktree-only.ts"]);
    expect(await call("files.read", { scope: { kind: "thread", id: thread.id }, path: path.join(root, "README.md") })).toMatchObject({
      kind: "file",
      outside: true,
      text: "# demo\n",
      readOnly: expect.any(String),
    });
    const task = await call("tasks.create", { projectId: p.id, title: "Preview source", useWorktree: false });
    expect(await call("files.read", { scope: { kind: "task", id: task.id }, path: "README.md" })).toMatchObject({ kind: "file", text: "# demo\n" });
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

  it("puts a task in a board column with the column's stage as its status, and takes it out when its status leaves that stage", async () => {
    const p = await call("projects.import", { rootPath: root });
    const [, review] = await call("board.saveColumns", {
      projectId: p.id,
      columns: [
        { name: "Build", stage: "in_progress" },
        { name: "Code review", stage: "in_progress" },
        { name: "Done", stage: "done" },
      ],
    });
    const task = await call("tasks.create", { projectId: p.id, title: "A card", useWorktree: false });
    expect(await call("tasks.update", { id: task.id, patch: { columnId: review!.id } })).toMatchObject({ status: "in_progress", columnId: review!.id });
    expect(await call("tasks.update", { id: task.id, patch: { status: "done" } })).toMatchObject({ status: "done", columnId: null });
    await expect(call("tasks.update", { id: task.id, patch: { columnId: "missing" } })).rejects.toThrow(/column/i);
  });

  it("starts a column's agent for a card put in it, lets agents send the card back, and asks the person on the fourth round", async () => {
    const p = await call("projects.import", { rootPath: root });
    const made = await call("board.saveColumns", {
      projectId: p.id,
      columns: [
        { name: "Build", stage: "in_progress", job: { prompt: "Do the work.", choice: null } },
        { name: "Code review", stage: "in_progress", job: { prompt: "Review the work.", choice: null } },
        { name: "Done", stage: "done" },
      ],
    });
    // A column hands finished work on only to a column after it.
    const [build, review, done] = await call("board.saveColumns", {
      projectId: p.id,
      columns: [{ ...made[0]!, nextColumnId: made[1]!.id }, { ...made[1]!, nextColumnId: made[0]!.id }, made[2]!],
    });
    expect(review!.nextColumnId).toBeNull();
    await call("board.saveColumns", { projectId: p.id, columns: [build!, { ...review!, nextColumnId: done!.id }, done!] });
    // Each column's agent gets a thread of its own for the task, as a pressed button's does.
    const agents = new Map<string, { thread: string; run: string }>();
    const opened = vi.spyOn(core.threads, "runTaskButton").mockImplementation(async (taskId, button) => {
      const thread = threads.insert(core.db, { projectId: p.id, title: button.label, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
      runs.insert(core.db, { id: `run-${thread.id}`, taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
      taskThreads.link(core.db, { taskId, threadId: thread.id, label: button.label });
      agents.set(button.label, { thread: thread.id, run: `run-${thread.id}` });
      return { threadId: thread.id };
    });
    const told = vi.spyOn(core.threads, "queue").mockReturnValue([]);
    try {
      const task = await call("tasks.create", { projectId: p.id, title: "A card", useWorktree: false });
      await call("tasks.update", { id: task.id, patch: { columnId: build!.id } });
      await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
      expect(opened.mock.calls[0]![1]).toMatchObject({ label: "Build", runsIn: "new" });
      expect(opened.mock.calls[0]![1].prompt).toMatch(/^Do the work\.\n\n.*move it to the "Code review" column with task_update/);
      const builder = agents.get("Build")!;
      core.boardJobs.move(task.id, "code review", builder.run);
      await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
      expect(opened.mock.calls[1]![1].prompt).toMatch(/^Review the work\.\n\nThis task came here from the "Build" column\..*move it to the "Done" column/);
      const reviewer = agents.get("Code review")!;
      expect(() => core.boardJobs.move(task.id, "Code review", reviewer.run)).toThrow(/already in/);
      expect(() => core.boardJobs.move(task.id, "Shipped", reviewer.run)).toThrow(/Build, Code review, Done/);
      // Sent back with notes, the builder's own thread carries on, told what was said.
      core.taskReports.post(task.id, reviewer.run, {
        message: "Two things to fix.",
        card: { kind: "checklist", title: "Review notes", items: [{ text: "Fix the header", done: false, detail: "Header.tsx:4" }] },
      });
      core.boardJobs.move(task.id, "Build", reviewer.run);
      await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(1));
      expect(told.mock.calls[0]![0]).toBe(builder.thread);
      expect(told.mock.calls[0]![1]).toMatch(/is back in the "Build" column\.\n\nThe latest notes on it:\nTwo things to fix\.\n- \[ \] Fix the header \(Header\.tsx:4\)\n\nDo the work\./);
      // The second round runs by itself.
      core.boardJobs.move(task.id, "Code review", builder.run);
      core.boardJobs.move(task.id, "Build", reviewer.run);
      await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(3));
      // The third review sends it back a third time: the fourth time the card reaches Build nothing starts, and the task asks the person.
      core.boardJobs.move(task.id, "Code review", builder.run);
      await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(4));
      core.boardJobs.move(task.id, "Build", reviewer.run);
      await vi.waitFor(async () => expect((await call("tasks.get", { id: task.id }))?.approval).toMatch(/sent to "Build" 4 times/));
      expect(told).toHaveBeenCalledTimes(4);
      const ask = (await call("tasks.events", { taskId: task.id })).findLast((event) => event.kind === "update")!;
      expect(ask).toMatchObject({ actor: { kind: "app" }, replies: ["Be more lenient", "Resolve it yourself"], replyThreadId: reviewer.thread });
      await call("tasks.answerUpdate", { taskId: task.id, eventId: ask.id, reply: "Resolve it yourself" });
      expect(told).toHaveBeenLastCalledWith(reviewer.thread, "Resolve it yourself");
      // A person's own move always starts the column's agent again.
      await call("tasks.update", { id: task.id, patch: { columnId: review!.id } });
      await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(6));
      expect(opened).toHaveBeenCalledTimes(2);
    } finally {
      opened.mockRestore();
      told.mockRestore();
    }
  });

  it("keeps an agent's update on its task, waits on the person while it asks, and sends their reply to the agent's thread", async () => {
    const p = await call("projects.import", { rootPath: root });
    const task = await call("tasks.create", { projectId: p.id, title: "Plan first", useWorktree: false });
    const builder = threads.insert(core.db, { projectId: p.id, title: "Builder", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const other = threads.insert(core.db, { projectId: p.id, title: "Reviewer", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    for (const thread of [builder, other]) runs.insert(core.db, { id: `run-${thread.id}`, taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const plan = { kind: "checklist" as const, title: "Plan", items: [{ text: "Draw the board", done: false }] };
    const id = core.taskReports.post(task.id, `run-${builder.id}`, { message: "Here is the plan.", card: plan, replies: ["Approve the plan"] });
    expect((await call("tasks.get", { id: task.id }))?.approval).toBe("Here is the plan.");
    // An agent changes its own update in place, and nobody else's.
    expect(() => core.taskReports.post(task.id, `run-${other.id}`, { message: "Mine now." }, id)).toThrow(/of yours/);
    const queued = vi.spyOn(core.threads, "queue").mockReturnValue([]);
    try {
      await expect(call("tasks.answerUpdate", { taskId: task.id, eventId: id, reply: "Something else" })).rejects.toThrow(/no longer offers/);
      await call("tasks.answerUpdate", { taskId: task.id, eventId: id, reply: "Approve the plan" });
      expect(queued).toHaveBeenCalledWith(builder.id, "Approve the plan");
      await expect(call("tasks.answerUpdate", { taskId: task.id, eventId: id, reply: "Approve the plan" })).rejects.toThrow(/already answered/);
    } finally {
      queued.mockRestore();
    }
    expect((await call("tasks.get", { id: task.id }))?.approval).toBeNull();
    expect(core.taskReports.post(task.id, `run-${builder.id}`, { message: "The plan is done.", card: { ...plan, items: [{ text: "Draw the board", done: true }] } }, id)).toBe(id);
    const update = (await call("tasks.events", { taskId: task.id })).find((event) => event.kind === "update");
    expect(update).toMatchObject({
      id,
      message: "The plan is done.",
      actor: { kind: "agent", agent: "codex", threadId: builder.id },
      answer: { reply: "Approve the plan" },
      card: { items: [{ done: true }] },
    });
  });

  it("adds ready-made board automations in their places, whichever comes first", async () => {
    const p = await call("projects.import", { rootPath: root });
    const plain = [
      { name: "Backlog", stage: "backlog" as const },
      { name: "In progress", stage: "in_progress" as const },
      { name: "Review", stage: "review" as const },
      { name: "Done", stage: "done" as const },
    ];
    for (const order of [
      ["plan_first", "build_review"],
      ["build_review", "plan_first"],
    ]) {
      await call("board.saveColumns", { projectId: p.id, columns: plain });
      for (const id of order) await call("board.addReadyMade", { projectId: p.id, id });
      const board = await call("board.columns", { projectId: p.id });
      expect(board.map((column) => column.name)).toEqual(["Backlog", "Plan", "Build", "Code review", "Review", "Done"]);
      // Each added column hands its cards to the one after it.
      expect(board.slice(1, 4).map((column) => board.find((next) => next.id === column.nextColumnId)?.name)).toEqual(["Build", "Code review", "Review"]);
      // Adding one the board already has changes nothing.
      expect(await call("board.addReadyMade", { projectId: p.id, id: order[0]! })).toEqual(board);
    }
    expect((await call("board.jobs", { projectId: p.id })).map((column) => column.name)).toEqual(["Plan", "Build", "Code review"]);
    const review = (await call("board.columns", { projectId: p.id })).find((column) => column.name === "Code review")!;
    await call("board.switchJob", { columnId: review.id, enabled: false });
    const pressed = vi.spyOn(core.threads, "runTaskButton").mockResolvedValue({ threadId: "job-thread" });
    try {
      const task = await call("tasks.create", { projectId: p.id, title: "A quiet card", useWorktree: false });
      await call("tasks.update", { id: task.id, patch: { columnId: review.id } });
      await new Promise((done) => setTimeout(done, 30));
      expect(pressed).not.toHaveBeenCalled();
    } finally {
      pressed.mockRestore();
    }
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
    expect(await call("tasks.get", { id: unstarted.id })).toEqual({ ...unstarted, approval: null });
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
    expect(await core.handle({ type: "rpc", id: 999, method: "nope", params: {} })).toMatchObject({ type: "rpc.error", id: 999 });
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])("answers the inherited name %s as an unknown method", async (method) => {
    expect(await core.handle({ type: "rpc", id: 1000, method, params: {} })).toEqual({ type: "rpc.error", id: 1000, message: `unknown method ${method}` });
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

  it("keeps every setting through a change to another, the default harness for every client included", async () => {
    expect((await call("app.settings.get", {})).defaultHarness).toBeNull();
    const optedOut = { idleProcessMinutes: null, claudeUserMcpServers: false };
    await call("app.settings.set", optedOut);
    await call("app.settings.set", { defaultHarness: "claude" });
    await call("app.settings.set", { defaultPermissionMode: "trusted" });
    await call("app.settings.set", { sound: true });
    expect(await call("app.settings.get", {})).toMatchObject({ ...optedOut, defaultHarness: "claude", defaultPermissionMode: "trusted", sound: true });
    await call("app.settings.set", { defaultHarness: null });
    expect((await call("app.settings.get", {})).defaultHarness).toBeNull();
    for (const id of harnessIds) {
      await call("app.settings.set", { defaultHarness: id });
      expect((await call("app.settings.get", {})).defaultHarness).toBe(id);
    }
    await expect(call("app.settings.set", { defaultHarness: "unknown-agent" as never })).rejects.toThrow();
  });

  it("answers which harnesses can start a thread as the desktop's New thread reads them, without their paths", async () => {
    const info = await call("system.info", { claudeAccountId: core.claudeAccounts.defaultId() });
    const availability = await call("agents.availability", {});
    expect(availability).toEqual(info.harnesses.map(({ id, state }) => ({ id, state })));
    expect(availability.map((row) => Object.keys(row))).toEqual(harnessIds.map(() => ["id", "state"]));
  });
});
