import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commitAll, git } from "@openorc/git";
import { checkpoints, listEvents, orchestration, projects, teamRuntime, threads, tasks, runs as runRepo } from "@openorc/db";
import { DEFAULT_TEAM_LIMITS, type Project, type Thread } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { ThreadService, titleFromPrompt, type ThreadPatch } from "./threads.js";
import { threadTurnChanges } from "./thread-turn-changes.js";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { WorkspaceWriters } from "./workspace-writers.js";
import { WorkspaceService } from "./workspace.js";
import { ReviewService } from "./review.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-threads-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-threads-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: () => {} } });
  project = await core.projects.import(root);
});

afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Each test owns its provider sessions; an idle resident still owns its checkout.
  const live = [
    ...threads.list(core.db, { projectId: project.id, filter: "all" }).flatMap((thread) => core.runs.liveRunForThread(thread.id) ?? []),
    ...tasks.list(core.db, { projectId: project.id }).flatMap((task) => core.runs.liveRunForTask(task.id) ?? []),
  ];
  try {
    await Promise.all(live.map((run) => core.runs.closeAndWait(run.id)));
  } finally {
    vi.restoreAllMocks();
  }
});

/** A thread row without spawning an agent, so the delegation rules can be tested on their own. */
function planThread(): Thread {
  return threads.insert(core.db, { projectId: project.id, title: "Plan the export", agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
}

/** The thread service with a canned namer, so naming can be tested without a model. */
function serviceNaming(title: string | null): ThreadService {
  const quiet = { info() {}, warn() {}, error() {} };
  return new ThreadService(
    core.db,
    core.runs,
    core.workspaces,
    () => {},
    quiet,
    async () => title,
  );
}

describe("compaction and delivery recovery", () => {
  async function idleSession(controls: { send: (text: string, attachments?: string[]) => Promise<void>; compact: () => Promise<void> }) {
    const thread = planThread();
    let handle!: RunHandle;
    const adapter = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
      let finish!: (code: number) => void;
      const done = new Promise<number>((resolve) => {
        finish = resolve;
      });
      handle = new RunHandle(spec.runId, {
        ...controls,
        interrupt() {},
        close() {
          handle.emit("exit", 0);
          finish(0);
        },
        done,
      });
      return handle;
    });
    const run = await core.runs.start({ scope: { task: null, thread }, project, agent: "codex", model: "fixture", mode: "plan", permissionMode: "trusted", prompt: "Hello", resume: false });
    adapter.mockRestore();
    handle.emit("event", { type: "session.started", runId: run.id, ts: Date.now(), agent: "codex", externalSessionId: "fixture", model: "fixture" });
    handle.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "first", status: "success", durationMs: 0 });
    await vi.waitFor(() => expect(core.runs.threadActivity(thread.id)).toBe("idle"));
    return { run, thread, handle };
  }

  it("coalesces compact requests, announces only completion, and defers sends", async () => {
    let finish!: () => void;
    const compact = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const send = vi.fn(async () => {});
    const { run, thread } = await idleSession({ compact, send });
    const events = vi.spyOn(core.ledger, "push");
    try {
      const first = core.runs.compact(run.id);
      const second = core.runs.compact(run.id);
      const delivery = core.runs.send(run.id, "After compaction", { attachments: ["/tmp/image.png"] });
      expect(compact).toHaveBeenCalledTimes(1);
      expect(core.runs.threadActivity(thread.id)).toBe("running");
      expect(send).not.toHaveBeenCalled();
      expect(events.mock.calls.flat().filter((e) => e.type === "message.completed" && e.role === "system")).toHaveLength(0);
      finish();
      await Promise.all([first, second, delivery]);
      expect(events.mock.calls.flat().filter((e) => e.type === "message.completed" && e.role === "system")).toHaveLength(1);
      expect(send).toHaveBeenCalledWith("After compaction", ["/tmp/image.png"]);
      expect(core.runs.threadActivity(thread.id)).toBe("running");
    } finally {
      events.mockRestore();
    }
  });

  it("keeps rejected messages out of the transcript and restores idle state for retry", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("cannot steer a compact turn")).mockResolvedValue(undefined);
    const { run, thread } = await idleSession({ compact: async () => {}, send });
    const events = vi.spyOn(core.ledger, "push");
    try {
      await expect(core.runs.send(run.id, "Retry this message")).rejects.toThrow("cannot steer a compact turn");
      expect(core.runs.threadActivity(thread.id)).toBe("idle");
      expect(events.mock.calls.flat().filter((e) => e.type === "message.completed" && e.text === "Retry this message")).toHaveLength(0);
      await core.runs.send(run.id, "Retry this message");
      expect(events.mock.calls.flat().filter((e) => e.type === "message.completed" && e.text === "Retry this message")).toHaveLength(1);
    } finally {
      events.mockRestore();
    }
  });

  it("drains a message queued during manual compaction when maintenance finishes", async () => {
    let finish!: () => void;
    const compact = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const send = vi.fn(async () => {});
    const { thread } = await idleSession({ compact, send });
    const pending = core.threads.compact(thread.id);
    core.threads.queue(thread.id, "Queued while compacting");
    expect(send).not.toHaveBeenCalled();
    finish();
    await pending;
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Queued while compacting", []));
    await vi.waitFor(() => expect(core.threads.get(thread.id)?.queued).toHaveLength(0));
  });
});

describe("stall detection", () => {
  /** Let the wall clock advance, so a later stamp is provably later and not the same millisecond. */
  const tick = async () => {
    const from = Date.now();
    while (Date.now() === from) await new Promise((resolve) => setTimeout(resolve, 1));
  };

  /** A thread with a live provider session whose events the test drives by hand. */
  async function liveThread() {
    const thread = planThread();
    let handle!: RunHandle;
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
    try {
      const run = await core.runs.start({ scope: { task: null, thread }, project, agent: "codex", model: "fixture", mode: "plan", permissionMode: "trusted", prompt: "Hello", resume: false });
      /** One mid-turn event, the kind that streams while the agent works and never ends a turn. */
      const stream = (name: string) => handle.emit("event", { type: "tool.started", runId: run.id, ts: Date.now(), toolCallId: name, name, input: {}, parentToolCallId: null });
      return { run, thread, stream };
    } finally {
      adapter.mockRestore();
    }
  }

  const seen = (threadId: string) => core.threads.get(threadId)!.lastAgentEventAt;

  it("keeps the newest event when the agent streams more than one", async () => {
    const { thread, stream } = await liveThread();
    stream("Read");
    await vi.waitFor(() => expect(seen(thread.id)).not.toBeNull());
    const first = seen(thread.id)!;
    await tick();
    stream("Write");
    await vi.waitFor(() => expect(seen(thread.id)!).toBeGreaterThan(first));
  });

  it("goes back to null once the run is no longer live", async () => {
    const { run, thread, stream } = await liveThread();
    stream("Bash");
    expect(seen(thread.id)).not.toBeNull();
    await core.runs.closeAndWait(run.id);
    expect(seen(thread.id)).toBeNull();
  });
});

describe("autonomous approvals", () => {
  it.each(["codex", "claude"] as const)("applies Autonomous to a running %s thread and releases tool approvals immediately", async (agent) => {
    const thread = threads.update(core.db, planThread().id, { mode: "act", agent, model: "fixture" });
    let handle!: RunHandle;
    const send = vi.fn(async () => {});
    const adapter = vi.spyOn(agent === "codex" ? CodexAdapter.prototype : ClaudeAdapter.prototype, "start").mockImplementation((spec, _launch) => {
      let finish!: (code: number) => void;
      const done = new Promise<number>((resolve) => {
        finish = resolve;
      });
      handle = new RunHandle(spec.runId, {
        send,
        interrupt() {},
        close() {
          handle.emit("exit", 0);
          finish(0);
        },
        done,
      });
      return handle;
    });
    let runId: string | undefined;
    try {
      const run = await core.runs.start({ scope: { thread, task: null }, project, agent, model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Hello", resume: false });
      runId = run.id;
      handle.emit("event", { type: "session.started", runId, ts: Date.now(), agent, externalSessionId: "live-permissions", model: "fixture" });
      const approval = core.runs.requestApproval(runId, "tool", "Bash", {});
      const question = core.runs.requestApproval(runId, "question", "AskUserQuestion", {});
      core.threads.update(thread.id, { permissionMode: "autonomous" });
      expect(
        core.runs
          .pending()
          .filter((p) => p.runId === runId)
          .map((p) => p.approvalId),
      ).toEqual(["question"]);
      await expect(approval).resolves.toMatchObject({ decision: "allow" });
      expect(core.runs.liveRunForThread(thread.id)?.permissionMode).toBe("autonomous");
      expect(runRepo.get(core.db, runId)?.permissionMode).toBe("autonomous");
      await expect(core.runs.requestApproval(runId, "next-tool", "Bash", {})).resolves.toMatchObject({ decision: "allow" });
      expect(adapter).toHaveBeenCalledTimes(1);
      core.runs.resolveApproval(runId, "question", "deny");
      await expect(question).resolves.toMatchObject({ decision: "deny" });
      core.threads.update(thread.id, { permissionMode: "trusted" });
      const restored = core.runs.requestApproval(runId, "restored", "Bash", {});
      expect(core.runs.pending().some((p) => p.runId === runId && p.approvalId === "restored")).toBe(true);
      core.runs.resolveApproval(runId, "restored", "deny");
      await expect(restored).resolves.toMatchObject({ decision: "deny" });
      handle.emit("event", { type: "turn.completed", runId, ts: Date.now(), turnId: "first", status: "success", durationMs: 0 });
    } finally {
      for (const pending of core.runs.pending().filter((p) => p.runId === runId)) core.runs.resolveApproval(pending.runId, pending.approvalId, "deny");
      handle?.close();
      adapter.mockRestore();
    }
  });

  it("surfaces Codex manual approval and honors an explicit switch to Autonomous", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-permissions-"));
    const binary = path.join(dir, "codex-fixture");
    await writeFile(
      binary,
      `#!${process.execPath}
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const approve = id => emit({ id, method: 'item/commandExecution/requestApproval', params: { command: 'fixture command' } });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method && message.id !== undefined) {
    emit({ id: message.id, result: message.method === 'thread/start' ? { thread: { id: 'fixture' } } : {} });
    if (message.method === 'turn/start') {
      emit({ method: 'turn/started', params: { turn: { id: 'first' } } });
      approve(901);
    }
  } else if (message.result?.decision === 'accept') {
    if (message.id === 901) approve(902);
    if (message.id === 902) emit({ method: 'turn/completed', params: { turn: { id: 'first', status: 'completed' } } });
  }
});
`,
      { mode: 0o755 },
    );
    const previousBinary = process.env["OPENORC_CODEX_BIN"];
    process.env["OPENORC_CODEX_BIN"] = binary;
    let runId: string | undefined;
    try {
      await core.environment.refresh();
      const thread = threads.update(core.db, planThread().id, { mode: "act", model: "fixture" });
      const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Fixture only", resume: false });
      runId = run.id;
      await vi.waitFor(() => expect(core.runs.pending().some((p) => p.runId === run.id && p.approvalId === "901")).toBe(true));
      expect(core.runs.threadActivity(thread.id)).toBe("waiting");
      core.threads.update(thread.id, { permissionMode: "autonomous" });
      await vi.waitFor(() => expect(core.runs.threadActivity(thread.id)).toBe("idle"));
      core.ledger.flush();
      expect(listEvents(core.db, run.id).filter((e) => e.type === "approval.resolved")).toEqual([
        expect.objectContaining({ approvalId: "901", decision: "allow" }),
        expect.objectContaining({ approvalId: "902", decision: "allow" }),
      ]);
      expect(listEvents(core.db, run.id).filter((e) => e.type === "approval.requested")).toHaveLength(1);
    } finally {
      if (previousBinary === undefined) delete process.env["OPENORC_CODEX_BIN"];
      else process.env["OPENORC_CODEX_BIN"] = previousBinary;
      await core.environment.refresh();
      if (runId) {
        core.runs.close(runId);
        await vi.waitFor(() => expect(runRepo.get(core.db, runId!)?.endedAt).not.toBeNull());
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("admits only one simultaneous start for a thread", async () => {
    const thread = planThread();
    const handles: RunHandle[] = [];
    const adapter = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
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
    const input = { scope: { thread, task: null }, project, agent: "codex" as const, model: "fixture", mode: "plan" as const, permissionMode: "trusted" as const, prompt: "Start once", resume: true };
    try {
      const results = await Promise.allSettled([core.runs.start(input), core.runs.start(input)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(adapter).toHaveBeenCalledTimes(1);
    } finally {
      handles.forEach((h) => h.close());
      adapter.mockRestore();
    }
  });

  it("accepts a tool permission without parking an autonomous act run", async () => {
    const thread = planThread();
    const run = runRepo.insert(core.db, { id: "autonomous-tool", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
    const result = core.runs.requestApproval(run.id, "consent", "ComputerUse", { app: "app.openorc.desktop" });
    try {
      await new Promise(setImmediate);
      expect(core.runs.pending().filter((p) => p.runId === run.id)).toHaveLength(0);
      await expect(result).resolves.toMatchObject({ decision: "allow" });
    } finally {
      if (core.runs.pending().some((p) => p.runId === run.id)) core.runs.resolveApproval(run.id, "consent", "deny");
    }
  });

  it.each([
    ["act", "trusted", "Bash"],
    ["act", "review", "Bash"],
    ["plan", "autonomous", "AskUserQuestion"],
    ["act", "autonomous", "AskUserQuestion"],
  ] as const)("keeps %s / %s / %s interactive", async (mode, permissionMode, tool) => {
    const thread = threads.update(core.db, planThread().id, { permissionMode: "autonomous" });
    const run = runRepo.insert(core.db, { id: `approval-${mode}-${permissionMode}-${tool}`, taskId: null, threadId: thread.id, agent: "claude", model: null, mode, permissionMode });
    const result = core.runs.requestApproval(run.id, "request", tool, {});
    try {
      expect(core.runs.pending().filter((p) => p.runId === run.id)).toHaveLength(1);
    } finally {
      core.runs.resolveApproval(run.id, "request", "deny");
    }
    await expect(result).resolves.toMatchObject({ decision: "deny" });
  });

  it("resumes the next turn with changed permissions and closes the old idle session", async () => {
    const thread = threads.update(core.db, planThread().id, { mode: "act", model: "fixture" });
    const handles: RunHandle[] = [];
    const adapter = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
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
    try {
      const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Hello", resume: false });
      const first = handles[0]!;
      first.emit("event", { type: "session.started", runId: run.id, ts: Date.now(), agent: "codex", externalSessionId: "permission-session", model: "fixture" });
      core.threads.update(thread.id, { permissionMode: "autonomous" });
      expect(core.runs.liveRunForThread(thread.id)?.permissionMode).toBe("autonomous");
      first.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "first", status: "success", durationMs: 0 });
      await vi.waitFor(() => expect(core.runs.threadActivity(thread.id)).toBe("idle"));
      await core.runs.send(run.id, "Continue autonomously");
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(adapter.mock.calls[1]?.[0]).toMatchObject({ permissionMode: "autonomous", resumeSessionId: "permission-session", prompt: "Continue autonomously" });
      expect(runRepo.get(core.db, run.id)?.endedAt).not.toBeNull();
      expect(core.runs.liveRunForThread(thread.id)?.permissionMode).toBe("autonomous");
    } finally {
      handles.at(-1)?.close();
      adapter.mockRestore();
    }
  });
});

describe("MCP backlog capture", () => {
  async function rpc(runId: string, method: string, params: unknown = {}) {
    const server = await core.mcpServer();
    const response = await fetch(server.urlForRun(runId), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(response.ok).toBe(true);
    const raw = await response.text();
    const payload = JSON.parse(
      raw.startsWith("{")
        ? raw
        : raw
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
    );
    expect(payload.error).toBeUndefined();
    expect(payload.result.isError).not.toBe(true);
    return payload.result;
  }

  it("creates a document in backlog through task_create without starting an agent", async () => {
    const thread = threads.update(core.db, planThread().id, { mode: "act" });
    const run = runRepo.insert(core.db, { id: "mcp-backlog", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "autonomous" });
    vi.spyOn(core.runs, "isLive").mockImplementation((id) => id === run.id);
    const start = vi.spyOn(core.threads, "startTask").mockRejectedValue(new Error("Backlog capture must not start an agent"));
    try {
      const spec =
        "## Goal\nGroup project tasks by status.\n\n## Acceptance criteria\n- [ ] Preserve filters\n- [ ] Update groups when status changes\n\n## Verification\nMove a task and verify its group and count.";
      const catalog = await rpc(run.id, "tools/list");
      expect(catalog.tools.some((tool: { name: string }) => /^(team_|execution_)/.test(tool.name) || tool.name === "task_complete")).toBe(false);
      expect(catalog.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "task_start" }),
          expect.objectContaining({
            name: "task_create",
            inputSchema: expect.objectContaining({ properties: expect.objectContaining({ execution: expect.objectContaining({ default: "backlog" }) }) }),
          }),
        ]),
      );
      const payload = await rpc(run.id, "tools/call", { name: "task_create", arguments: { title: "Group project tasks by status", spec, labels: ["workflow", "tasks"] } });
      const result = JSON.parse(payload.content[0].text);
      expect(result.task.status).toBe("backlog");
      expect(result.started).toBe(false);
      expect(start).not.toHaveBeenCalled();
      const stored = await core.threads.toolList(run.id);
      expect(stored).toHaveLength(1);
      expect(core.db.stmt("SELECT spec, worktree_path FROM tasks WHERE id = ?").get(result.task.id)).toMatchObject({ spec, worktree_path: null });
      expect(runRepo.listForTask(core.db, result.task.id)).toHaveLength(0);
      expect(tasks.get(core.db, result.task.id)?.labels).toEqual(["workflow", "tasks"]);
      const duplicate = await core.threads.toolCreate(run.id, { title: "Group project tasks by status", spec, execution: "delegate" });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.task.id).toBe(result.task.id);
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });

  it("captures in Plan without delegation and refuses starting from a Plan run", async () => {
    const thread = planThread();
    const run = runRepo.insert(core.db, { id: "mcp-plan", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
    // A future composer setting cannot turn an in-flight Plan run into Act.
    threads.update(core.db, thread.id, { mode: "act" });
    const captured = await core.threads.toolCreate(run.id, { title: "Capture idea", spec: "## Goal\nKeep this for later." });
    expect(captured.task.status).toBe("backlog");
    const proposed = await core.threads.toolCreate(run.id, { title: "Proposed implementation", spec: "## Goal\nImplement on approval.", execution: "delegate" });
    expect(proposed.task.status).toBe("backlog");
    expect(proposed.started).toBe(false);
    await expect(core.threads.toolStart(run.id, captured.task.id)).rejects.toThrow("Plan mode cannot start tasks");
  });

  it("starts explicitly requested tasks across threads in the same project", async () => {
    const thread = threads.update(core.db, planThread().id, { mode: "act" });
    const run = runRepo.insert(core.db, { id: "mcp-act", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    vi.spyOn(core.runs, "isLive").mockImplementation((id) => id === run.id);
    const start = vi.spyOn(core.threads, "startTask").mockImplementation(async (task) => tasks.update(core.db, task.id, { status: "in_progress" }));
    try {
      const delegated = await core.threads.toolCreate(run.id, { title: "Execute now", spec: "Requested work", execution: "delegate" });
      expect(delegated.started).toBe(false);
      expect(start).not.toHaveBeenCalled();
      const captured = await core.threads.toolCreate(run.id, { title: "Execute later", spec: "Saved work" });
      expect(start).not.toHaveBeenCalled();
      const started = await rpc(run.id, "tools/call", { name: "task_start", arguments: { id: captured.task.id } });
      expect(JSON.parse(started.content[0].text).status).toBe("in_progress");
      expect(start).not.toHaveBeenCalled();
      const other = await core.threads.spawnTask(planThread(), { title: "Other thread's task", spec: "Unrelated", execution: "backlog" }, "user");
      expect((await core.threads.toolStart(run.id, other.task.id)).status).toBe("in_progress");
      expect(tasks.get(core.db, other.task.id)?.threadId).toBe(other.task.threadId);
      const taskRun = runRepo.insert(core.db, { id: "task-caller", taskId: delegated.task.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
      expect((await core.threads.toolStart(taskRun.id, other.task.id)).status).toBe("in_progress");
      await expect(core.threads.toolStart(run.id, "missing-task")).rejects.toThrow("project");
      tasks.update(core.db, captured.task.id, { status: "done" }, { explicitStatus: true });
      await expect(core.threads.toolStart(run.id, captured.task.id)).rejects.toThrow("finished");
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });
});

describe("threads", () => {
  it("routes real thread naming to text generation even with memory turned off", async () => {
    await core.memory.updateSettings({ provider: "off" });
    const title = vi.spyOn(core.textGeneration, "title").mockResolvedValue("Independent title settings");
    const memory = vi.spyOn(core.memory, "extractor");
    const prompt = "Separate our title configuration";
    const thread = threads.insert(core.db, { projectId: project.id, title: titleFromPrompt(prompt), agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    try {
      await core.threads.onTurnCompleted(thread, { prompt, reply: "Done" });
      expect(threads.get(core.db, thread.id)?.title).toBe("Independent title settings");
      expect(title).toHaveBeenCalledWith({ request: prompt, reply: "Done" }, "codex");
      expect(memory).not.toHaveBeenCalled();
    } finally {
      title.mockRestore();
      memory.mockRestore();
    }
  });

  it("names a thread from its first exchange while the title is still the prompt's first line", async () => {
    const prompt = "Add CSV export\nwith filters";
    const thread = threads.insert(core.db, { projectId: project.id, title: titleFromPrompt(prompt), agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    await serviceNaming("CSV export with filters").onTurnCompleted(thread, { prompt, reply: "Done." });
    expect(threads.get(core.db, thread.id)?.title).toBe("CSV export with filters");
    // A later turn leaves the model's name alone, and so does a failed naming.
    await serviceNaming("Something else").onTurnCompleted({ ...thread, title: "CSV export with filters" }, { prompt: "Now add tests", reply: null });
    expect(threads.get(core.db, thread.id)?.title).toBe("CSV export with filters");
  });

  it("saves task records in Plan without starting work", async () => {
    const thread = planThread();
    const { task, duplicate, started } = await core.threads.spawnTask(thread, { title: "Write the CSV writer", spec: "Stream rows; escape quotes." }, "agent");
    expect(task.status).toBe("backlog");
    expect(task.origin).toBe("agent");
    expect(task.threadId).toBe(thread.id);
    expect(duplicate).toBe(false);
    expect(started).toBe(false);
    const summary = core.threads.get(thread.id);
    expect(summary?.taskCount).toBe(1);
    expect(summary?.openTaskCount).toBe(1);
    expect(summary?.activity).toBe("idle");
  });

  it("scopes the agent tools to the calling run and refuses task creation from inside a task", async () => {
    const thread = planThread();
    const { task } = await core.threads.spawnTask(thread, { title: "Scoped task", spec: "For tool scoping." }, "user");
    const { runs } = await import("@openorc/db");
    const threadRun = runs.insert(core.db, { id: "run-thread", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
    const taskRun = runs.insert(core.db, { id: "run-task", taskId: task.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const fromThread = await core.threads.toolList(threadRun.id);
    expect(fromThread.map((t) => t.id)).toContain(task.id);
    const fromTask = await core.threads.toolList(taskRun.id);
    expect(fromTask.find((item) => item.id === task.id)?.current).toBe(true);
    await expect(core.threads.toolCreate(taskRun.id, { title: "Nested", spec: "Should be refused." })).rejects.toThrow(/Only a thread/);
    const updated = await core.threads.toolUpdate(threadRun.id, task.id, { spec: "Refined spec." });
    expect(updated?.id).toBe(task.id);
  });
});

describe("task tool access and team execution boundaries", () => {
  function task(threadId: string | null, projectId = project.id) {
    return tasks.insert(core.db, {
      projectId,
      threadId,
      title: "Scoped work",
      spec: "Original specification",
      priority: "none",
      labels: [],
      workspaceMode: "current",
      baseRef: null,
      parentTaskId: null,
    });
  }

  it("allows all project tasks across threads but rejects other projects and unknown runs", async () => {
    const thread = planThread();
    const otherThread = planThread();
    const otherProject = projects.insert(core.db, { name: "Foreign scope", rootPath: path.join(root, "foreign-scope"), defaultBranch: "main", gitRemote: null, settings: {} });
    const own = task(thread.id);
    const sibling = task(thread.id);
    const foreignThread = task(otherThread.id);
    const foreignProject = task(thread.id, otherProject.id);
    const unthreaded = task(null);
    const threadRun = runRepo.insert(core.db, { id: "scope-thread", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const taskRun = runRepo.insert(core.db, { id: "scope-task", taskId: own.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    for (const caller of [threadRun, taskRun]) {
      const listed = (await core.threads.toolList(caller.id)).map((item) => item.id);
      expect(listed).toEqual(expect.arrayContaining([own, sibling, foreignThread, unthreaded].map((item) => item.id)));
      expect(listed).not.toContain(foreignProject.id);
      for (const allowed of [own, sibling, foreignThread, unthreaded]) {
        await expect(core.threads.toolGet(caller.id, allowed.id)).resolves.toMatchObject({ id: allowed.id, current: caller.taskId === allowed.id });
        await expect(core.threads.toolUpdate(caller.id, allowed.id, { spec: "Updated within scope" })).resolves.toMatchObject({ id: allowed.id });
      }
      for (const denied of [foreignProject]) {
        await expect(core.threads.toolGet(caller.id, denied.id)).resolves.toBeNull();
        await expect(core.threads.toolStart(caller.id, denied.id)).rejects.toThrow("project");
        await expect(core.threads.toolUpdate(caller.id, denied.id, { status: "archived", spec: "Unauthorized" })).resolves.toBeNull();
        expect(tasks.get(core.db, denied.id)).toEqual(denied);
      }
    }
    const before = tasks.get(core.db, own.id);
    await expect(core.threads.toolGet("unknown-run", own.id)).resolves.toBeNull();
    await expect(core.threads.toolUpdate("unknown-run", own.id, { status: "done" })).resolves.toBeNull();
    const mismatchedRun = runRepo.insert(core.db, { id: "scope-mismatched-project", taskId: foreignProject.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    await expect(core.threads.toolGet(mismatchedRun.id, own.id)).resolves.toBeNull();
    await expect(core.threads.toolUpdate(mismatchedRun.id, own.id, { status: "done" })).resolves.toBeNull();
    expect(tasks.get(core.db, own.id)).toEqual(before);
  });

  it("lets an independent task agent access other tasks in its project", async () => {
    const own = task(null);
    const sibling = task(null);
    const threaded = task(planThread().id);
    const run = runRepo.insert(core.db, { id: "scope-unthreaded", taskId: own.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    await expect(core.threads.toolGet(run.id, own.id)).resolves.toMatchObject({ id: own.id, current: true });
    await expect(core.threads.toolUpdate(run.id, own.id, { status: "done", spec: "Completed own work" })).resolves.toMatchObject({ id: own.id, status: "done", current: true });
    for (const allowed of [sibling, threaded]) {
      await expect(core.threads.toolGet(run.id, allowed.id)).resolves.toMatchObject({ id: allowed.id, current: false });
      await expect(core.threads.toolUpdate(run.id, allowed.id, { status: "archived" })).resolves.toMatchObject({ id: allowed.id, status: "archived" });
    }
  });

  it("rejects generic team launches and queues before workspace or thread changes", async () => {
    const thread = threads.update(core.db, planThread().id, { workspaceMode: "worktree", snoozedUntil: Date.now() + 60000 });
    const owned = task(thread.id);
    const team = orchestration.save(core.db, {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Managed execution",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture", effort: null, fastMode: false } }],
      },
    });
    orchestration.createInstance(core.db, { threadId: thread.id, teamRevisionId: team.revision.id });
    const prepare = vi.spyOn(core.workspaces, "prepare");
    const prepareThread = vi.spyOn(core.workspaces, "prepareThread");
    const start = vi.spyOn(core.runs, "start");
    const send = vi.spyOn(core.runs, "send");
    try {
      // The current task row decides ownership even when a caller passes an old copy.
      await expect(core.threads.startTask({ ...owned, threadId: null }, undefined, "worktree")).rejects.toThrow(/managed by a saved team/);
      await expect(
        core.threads.continueThread(thread.id, { agent: "claude", model: "other", effort: "high", fastMode: false, mode: "act", permissionMode: "autonomous", prompt: "Bypass", attachments: [] }),
      ).rejects.toThrow(/managed by a saved team/);
      expect(() => core.threads.queue(thread.id, "Bypass queue")).toThrow(/managed by a saved team/);
      await expect(core.threads.send(thread.id, "Bypass delivery", null)).rejects.toThrow(/managed by a saved team/);
      expect(core.threads.get(thread.id)?.queued).toEqual([]);
      expect(tasks.get(core.db, owned.id)).toEqual(owned);
      expect(threads.get(core.db, thread.id)).toEqual(thread);
      expect(prepare).not.toHaveBeenCalled();
      expect(prepareThread).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      prepareThread.mockRestore();
      start.mockRestore();
      send.mockRestore();
    }
  });

  it("rejects direct structural team updates atomically while allowing presentation edits", () => {
    const thread = planThread();
    const team = orchestration.save(core.db, {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Update guard",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture", effort: null, fastMode: false } }],
      },
    });
    orchestration.createInstance(core.db, { threadId: thread.id, teamRevisionId: team.revision.id });
    const blocked: ThreadPatch[] = [{ agent: "claude" }, { model: "different" }, { model: null }, { effort: "high" }, { effort: null }, { fastMode: true }, { fastMode: false }];
    const applyPermissions = vi.spyOn(core.runs, "applyThreadPermissions");
    try {
      for (const patch of blocked) {
        expect(() => core.threads.update(thread.id, { title: "Do not partly save", draft: "Do not partly save", ...patch })).toThrow(/managed by a saved team/);
        expect(threads.get(core.db, thread.id)).toEqual(thread);
      }
      expect(applyPermissions).not.toHaveBeenCalled();
      expect(core.threads.update(thread.id, { title: "Renamed team work", draft: "Unsaved prompt", pinned: true, seen: true })).toMatchObject({
        title: "Renamed team work",
        draft: "Unsaved prompt",
        pinnedAt: expect.any(Number),
        seenAt: expect.any(Number),
      });
      expect(core.threads.update(thread.id, { pinned: false }).pinnedAt).toBeNull();
    } finally {
      applyPermissions.mockRestore();
    }
  });

  it("organizes a quiescent pinned team and changes its next-execution policy without starting or cleaning work", () => {
    const thread = planThread();
    const team = orchestration.save(core.db, {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Quiet team",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture", effort: null, fastMode: false } }],
      },
    });
    const instance = orchestration.createInstance(core.db, { threadId: thread.id, teamRevisionId: team.revision.id });
    const start = vi.spyOn(core.runs, "start");
    const cleanup = vi.spyOn(core.workspaces, "cleanupThread");
    try {
      expect(core.threads.update(thread.id, { mode: "act", permissionMode: "autonomous", pinned: true })).toMatchObject({ mode: "act", permissionMode: "autonomous", pinnedAt: expect.any(Number) });
      expect(core.threads.update(thread.id, { done: true })).toMatchObject({ doneAt: null, pinnedAt: expect.any(Number), snoozedUntil: null });
      expect(core.threads.update(thread.id, { done: false }).doneAt).toBeNull();
      expect(core.threads.update(thread.id, { archived: true }).archivedAt).not.toBeNull();
      expect(core.threads.update(thread.id, { archived: false }).archivedAt).toBeNull();
      const until = Date.now() + 60_000;
      expect(core.threads.update(thread.id, { snoozedUntil: until }).snoozedUntil).toBe(until);
      expect(core.threads.update(thread.id, { snoozedUntil: null }).snoozedUntil).toBeNull();
      expect(orchestration.getInstance(core.db, thread.id)).toEqual(instance);
      expect(start).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
      cleanup.mockRestore();
    }
  });

  it("changes an unfinished team's requested mode and permissions while rejecting organization patches atomically", () => {
    const thread = planThread();
    const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
    const team = orchestration.save(core.db, {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Live policy",
        limits: DEFAULT_TEAM_LIMITS,
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings }],
      },
    });
    const instance = orchestration.createInstance(core.db, { threadId: thread.id, teamRevisionId: team.revision.id });
    const execution = teamRuntime.create(core.db, {
      id: `policy-${thread.id}`,
      instanceId: instance.id,
      threadId: thread.id,
      projectId: project.id,
      state: "active",
      generation: 1,
      revision: 0,
      limits: DEFAULT_TEAM_LIMITS,
      actors: [
        {
          id: "lead",
          memberKey: "lead",
          parentId: null,
          taskId: null,
          requestKey: null,
          requestHash: null,
          dependencies: [],
          input: { title: "Policy", spec: "Keep working", attachments: [], responsibility: "Coordinate", settings },
          state: "queued",
          retries: 0,
          directionVersion: 0,
          deliveredVersion: 0,
          disposition: null,
          result: null,
          snapshotId: null,
          error: null,
        },
      ],
      attempts: [],
      messages: [],
      error: null,
      createdAt: 1000,
      updatedAt: 1000,
      deadlineAt: 60000,
    });
    for (const patch of [{ archived: true }, { done: true }, { snoozedUntil: Date.now() + 60000 }]) {
      expect(() => core.threads.update(thread.id, { ...patch, mode: "act", permissionMode: "autonomous", title: "Must not save" })).toThrow(/unfinished execution/);
      expect(threads.get(core.db, thread.id)).toEqual(thread);
    }
    expect(core.threads.update(thread.id, { permissionMode: "autonomous" })).toMatchObject({ permissionMode: "autonomous", mode: "plan", title: thread.title });
    expect(core.runs.threadPermissions(thread.id)).toEqual({
      mode: { requested: "plan", effective: "plan", pending: false },
      requested: "autonomous",
      effective: "review",
      pendingRestart: false,
      runs: [],
    });
    expect(teamRuntime.get(core.db, execution.id)).toEqual(execution);
    const changed = vi.spyOn(core.teams, "modeChanged").mockImplementation(() => {});
    try {
      expect(core.threads.update(thread.id, { mode: "act" }).mode).toBe("act");
      expect(changed).toHaveBeenCalledExactlyOnceWith(thread.id);
      core.threads.update(thread.id, { mode: "act" });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(teamRuntime.get(core.db, execution.id)).toEqual(execution);
    } finally {
      changed.mockRestore();
    }
    expect(core.threads.get(thread.id)?.hasStarted).toBe(true);
    teamRuntime.update(core.db, execution.id, (draft) => {
      draft.state = "stopped";
    });
    expect(teamRuntime.activeForThread(core.db, thread.id)).toBeNull();
    expect(core.threads.get(thread.id)?.hasStarted).toBe(true);
  });
});

describe("thread creation admission", () => {
  it.each(["current", "worktree"] as const)("does not create records or prepare a %s workspace when its destination is reserved", async (workspaceMode) => {
    const writers = new WorkspaceWriters();
    const quiet = { info() {}, warn() {}, error() {} };
    const workspaces = new WorkspaceService(core.db, { dataDir }, quiet, writers);
    const invalidate = vi.fn();
    const service = new ThreadService(core.db, core.runs, workspaces, invalidate, quiet, async () => null, writers);
    const prepare = vi.spyOn(workspaces, "prepareThread");
    const start = vi.spyOn(core.runs, "start").mockRejectedValue(new Error("Admission must finish before starting a provider"));
    const records = () => ({
      threads: core.db.stmt("SELECT * FROM threads").all(),
      runs: core.db.stmt("SELECT * FROM runs").all(),
      audit: core.db.stmt("SELECT * FROM audit_events").all(),
    });
    const before = records();
    const lease = await writers.acquire(workspaceMode === "current" ? project.rootPath : path.join(dataDir, "worktrees"), "another workspace operation");
    try {
      await expect(
        service.start({
          projectId: project.id,
          agent: "codex",
          model: "fixture",
          effort: undefined,
          mode: "act",
          permissionMode: "trusted",
          workspaceMode,
          prompt: "Start after workspace admission",
          attachments: [],
          title: undefined,
        }),
      ).rejects.toThrow(/another workspace operation/);
      expect(records()).toEqual(before);
      expect(prepare).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      lease.release();
      prepare.mockRestore();
      start.mockRestore();
      await workspaces.shutdown();
    }
  });
});

describe("turn changes", () => {
  it("diffs each checkpoint against the one before it, and the first against the thread's base commit", async () => {
    const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const thread = threads.update(core.db, threads.insert(core.db, { projectId: project.id, title: "Turn changes", agent: "claude", model: null, mode: "act", permissionMode: "trusted" }).id, {
      baseSha,
    })!;
    // Trees are borrowed from throwaway commits so the checkpoints point at real objects; the checkout is put back after.
    await writeFile(path.join(root, "README.md"), "# demo\nfirst turn\n");
    await writeFile(path.join(root, "added.txt"), "new\n");
    await commitAll(root, "turn one");
    const first = (await git(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    await writeFile(path.join(root, "added.txt"), "new\nsecond turn\n");
    await commitAll(root, "turn two");
    const second = (await git(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    await git(root, ["reset", "-q", "--hard", baseSha]);
    try {
      const stat = { files: 0, insertions: 0, deletions: 0, untracked: 0 };
      const one = checkpoints.insert(core.db, { threadId: thread.id, runId: null, turn: 1, treeSha: first, diffStat: stat });
      const two = checkpoints.insert(core.db, { threadId: thread.id, runId: null, turn: 2, treeSha: second, diffStat: stat });
      await expect(threadTurnChanges(core.db, { threadId: thread.id, checkpointId: one.id })).resolves.toEqual({
        files: [
          { path: "README.md", added: 1, removed: 0 },
          { path: "added.txt", added: 1, removed: 0 },
        ],
        patch: null,
      });
      const later = await threadTurnChanges(core.db, { threadId: thread.id, checkpointId: two.id, includePatch: true });
      expect(later.files).toEqual([{ path: "added.txt", added: 1, removed: 0 }]);
      expect(later.patch).toContain("+second turn");
      await expect(threadTurnChanges(core.db, { threadId: thread.id, checkpointId: one.id, paths: ["added.txt"] })).resolves.toMatchObject({ files: [{ path: "added.txt" }] });
      const other = threads.insert(core.db, { projectId: project.id, title: "Other thread", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
      await expect(threadTurnChanges(core.db, { threadId: other.id, checkpointId: one.id })).rejects.toThrow("does not belong");
      const unbased = checkpoints.insert(core.db, { threadId: other.id, runId: null, turn: 1, treeSha: first, diffStat: stat });
      await expect(threadTurnChanges(core.db, { threadId: other.id, checkpointId: unbased.id })).rejects.toThrow("comparison checkpoint is unavailable");
    } finally {
      await git(root, ["reset", "-q", "--hard", baseSha]);
    }
  });
});

describe("thread lifecycle", () => {
  const insert = (title: string) => threads.insert(core.db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });

  it("blocks review, move, restore, and delete when another scope owns the same checkout", async () => {
    const writers = new WorkspaceWriters();
    const quiet = { info() {}, warn() {}, error() {} };
    const workspaces = new WorkspaceService(core.db, { dataDir }, quiet, writers);
    const service = new ThreadService(
      core.db,
      core.runs,
      workspaces,
      () => {},
      quiet,
      async () => null,
      writers,
    );
    const review = new ReviewService(core.db, writers);
    const thread = insert("Shared physical checkout");
    const task = tasks.insert(core.db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Review work",
      spec: "Review",
      priority: "none",
      labels: [],
      workspaceMode: "current",
      baseRef: "main",
      parentTaskId: null,
    });
    const checkpoint = checkpoints.insert(core.db, {
      threadId: thread.id,
      runId: null,
      turn: 1,
      treeSha: (await git(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim(),
      diffStat: { files: 0, insertions: 0, deletions: 0, untracked: 0 },
    });
    const lease = await writers.acquire(project.rootPath, "another conversation's provider");
    try {
      for (const operation of [
        () => service.restore(thread.id, checkpoint.id),
        () => service.moveWorkspace(thread.id, "worktree"),
        () => service.delete(thread.id),
        () => review.commitProject(project, "Should not commit"),
        () => review.commitThread(thread, project, "Should not commit"),
        () => review.pushThread(thread, project),
        () => review.createThreadPr(thread, project, "Should not publish", "Blocked", "main"),
        () => review.commit(task, project, "Should not commit"),
        () => review.push(task, project),
        () => review.createPr(task, project, "Should not publish", "Blocked", "main"),
      ])
        await expect(operation()).rejects.toThrow(/another conversation's provider/);
      expect(threads.get(core.db, thread.id)).toEqual(thread);
      expect(tasks.get(core.db, task.id)).toEqual(task);
    } finally {
      lease.release();
    }
  });

  it("pins, snoozes and archives threads while ignoring legacy completion requests", () => {
    const a = insert("Pinned one");
    const b = insert("Finished one");
    const c = insert("Archived one");
    core.threads.update(a.id, { pinned: true });
    core.threads.update(b.id, { pinned: true, done: true });
    core.threads.update(c.id, { archived: true });
    const active = core.threads.list({ projectId: project.id, filter: "active" }).map((t) => t.title);
    expect(active.slice(0, 2)).toEqual(expect.arrayContaining(["Pinned one", "Finished one"]));
    expect(active).toContain("Finished one");
    expect(core.threads.list({ projectId: project.id, filter: "done" }).map((t) => t.title)).toEqual([]);
    expect(core.threads.list({ projectId: project.id, filter: "archived" }).map((t) => t.title)).toEqual(["Archived one"]);
    // Legacy done requests do not hide or unpin conversations.
    expect(core.threads.get(b.id)?.pinnedAt).not.toBeNull();
    const until = Date.now() + 3_600_000;
    expect(core.threads.update(a.id, { snoozedUntil: until }).snoozedUntil).toBe(until);
  });

  it("tracks what the user has seen", () => {
    const t = insert("Seen or not");
    expect(core.threads.get(t.id)?.unread).toBe(false);
    // Activity after the last look is unread.
    core.db.stmt("UPDATE threads SET seen_at = last_activity_at - 1000 WHERE id = ?").run(t.id);
    expect(core.threads.get(t.id)?.unread).toBe(true);
    core.threads.update(t.id, { seen: true });
    expect(core.threads.get(t.id)?.unread).toBe(false);
    core.threads.update(t.id, { seen: false });
    expect(core.threads.get(t.id)?.unread).toBe(true);
  });

  it("reports the session behind a thread from its last run", () => {
    const t = insert("Session state");
    expect(core.threads.get(t.id)?.session).toEqual({ status: "idle", message: null });
    const { runs } = core;
    void runs;
    const r = core.db.stmt("INSERT INTO runs (id, thread_id, agent, mode, permission_mode, state, started_at, error) VALUES (?, ?, 'claude', 'act', 'trusted', 'error', ?, ?)");
    r.run("run-lost", t.id, Date.now(), "No conversation found with session ID: abc");
    expect(core.threads.get(t.id)?.session.status).toBe("lost");
    core.db.stmt("UPDATE runs SET error = ? WHERE id = ?").run("API Error: 500", "run-lost");
    expect(core.threads.get(t.id)?.session.status).toBe("error");
  });

  it("marks runs the previous instance left open as interrupted", () => {
    const t = insert("Left open");
    core.db.stmt("INSERT INTO runs (id, thread_id, agent, mode, permission_mode, state, started_at) VALUES (?, ?, 'codex', 'act', 'trusted', 'running', ?)").run("run-open", t.id, Date.now());
    core.runs.recoverInterrupted();
    const run = core.db.stmt("SELECT state, error FROM runs WHERE id = ?").get("run-open") as { state: string; error: string };
    expect(run.state).toBe("error");
    expect(run.error).toMatch(/closed while this session was open/);
    core.ledger.flush();
    expect(listEvents(core.db, "run-open")).toContainEqual(expect.objectContaining({ type: "session.completed", status: "error", eventId: expect.any(String) }));
  });

  it("forks a thread and reads the conversation across the fork point", () => {
    const parent = insert("Parent");
    const ins = core.db.stmt("INSERT INTO runs (id, thread_id, agent, mode, permission_mode, state, started_at, external_session_id) VALUES (?, ?, 'codex', 'act', 'trusted', 'success', ?, ?)");
    ins.run("p-1", parent.id, 1, "sess-1");
    ins.run("p-2", parent.id, 2, "sess-2");
    const fork = core.threads.fork(parent.id, "p-1");
    expect(fork.forkedFromId).toBe(parent.id);
    expect(fork.forkedAtRunId).toBe("p-1");
    expect(fork.title).toBe("Parent (fork)");
    expect(core.threads.conversationRuns(fork.id).map((r) => r.id)).toEqual(["p-1"]);
    ins.run("f-1", fork.id, 3, "sess-3");
    expect(core.threads.conversationRuns(fork.id).map((r) => r.id)).toEqual(["p-1", "f-1"]);
    expect(core.threads.conversationRuns(parent.id).map((r) => r.id)).toEqual(["p-1", "p-2"]);
    expect(() => core.threads.fork(parent.id, "nope")).toThrow(/not part of this thread/);
  });

  it("keeps failed queued messages and prevents concurrent double delivery", async () => {
    const t = insert("Queue");
    const r = runRepo.insert(core.db, { id: "queue-run", taskId: null, threadId: t.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const activity = vi.spyOn(core.runs, "threadActivity").mockReturnValue("idle");
    const resume = vi.spyOn(core.threads, "continueThread").mockRejectedValueOnce(new Error("provider offline"));
    try {
      core.threads.queue(t.id, "Keep this message", ["/tmp/attachment.png"]);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(core.threads.get(t.id)?.queued[0]?.text).toBe("Keep this message");
      let accept!: (run: typeof r) => void;
      resume.mockImplementation(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          }),
      );
      core.threads.queue(t.id, "Second");
      core.threads.queue(t.id, "Third");
      expect(resume).toHaveBeenCalledTimes(1);
      const retry = core.threads.sendQueued(t.id, core.threads.get(t.id)!.queued[0]!.id);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
      activity.mockReturnValue("running");
      accept(r);
      await retry;
      await vi.waitFor(() => expect(core.threads.get(t.id)?.queued.map((q) => q.text)).toEqual(["Second", "Third"]));
    } finally {
      activity.mockRestore();
      resume.mockRestore();
    }
  });

  it("resumes pending queue delivery when an idle conversation is unarchived", async () => {
    const t = insert("Archived queue");
    const r = runRepo.insert(core.db, { id: "unarchive-run", taskId: null, threadId: t.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const activity = vi.spyOn(core.runs, "threadActivity").mockReturnValue("running");
    const deliver = vi.spyOn(core.threads, "continueThread").mockResolvedValue(r);
    core.threads.queueFollowUp({ threadId: t.id, text: "Wait while archived", requestKey: "archive" });
    core.threads.update(t.id, { archived: true });
    activity.mockReturnValue("idle");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliver).not.toHaveBeenCalled();
    core.threads.update(t.id, { archived: false });
    await vi.waitFor(() => expect(core.threads.get(t.id)?.queued).toEqual([]));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("handles a rejected send-now while another follow-up waits on the same delivery", async () => {
    const t = insert("Rejected steering");
    const r = runRepo.insert(core.db, { id: "steer-rejected-run", taskId: null, threadId: t.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    vi.spyOn(core.runs, "threadActivity").mockReturnValue("running");
    vi.spyOn(core.runs, "liveRunForThread").mockImplementation((id) => (id === t.id ? r : null));
    vi.spyOn(core.runs, "canSteer").mockReturnValue(true);
    let reject!: (error: Error) => void;
    vi.spyOn(core.runs, "send").mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const receipt = core.threads.queueFollowUp({ threadId: t.id, text: "Send now", requestKey: "steer-first" });
    const sending = expect(core.threads.sendQueued(t.id, receipt.messageId)).rejects.toThrow("Provider refused");
    core.threads.queueFollowUp({ threadId: t.id, text: "Next", requestKey: "steer-next" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    reject(new Error("Provider refused"));
    await sending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(core.threads.get(t.id)?.queued).toMatchObject([{ text: "Send now", interrupted: true }, { text: "Next" }]);
  });

  it("targets queue actions by message identity after earlier messages leave the list", async () => {
    const t = insert("Queue identity");
    const r = runRepo.insert(core.db, { id: "queue-identity-run", taskId: null, threadId: t.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    vi.spyOn(core.runs, "threadActivity").mockReturnValue("running");
    vi.spyOn(core.runs, "liveRunForThread").mockImplementation((id) => (id === t.id ? r : null));
    vi.spyOn(core.runs, "canSteer").mockReturnValue(true);
    const send = vi.spyOn(core.runs, "send").mockResolvedValue();
    const first = core.threads.queueFollowUp({ threadId: t.id, text: "First", requestKey: "first" });
    const second = core.threads.queueFollowUp({ threadId: t.id, text: "Second", requestKey: "second" });
    const third = core.threads.queueFollowUp({ threadId: t.id, text: "Third", requestKey: "third" });
    await core.threads.sendQueued(t.id, first.messageId);
    core.threads.unqueue(t.id, first.messageId); // A stale remove cannot cancel Second.
    expect(core.threads.get(t.id)?.queued.map((m) => m.id)).toEqual([second.messageId, third.messageId]);
    await expect(core.threads.sendQueued(t.id, first.messageId)).rejects.toThrow(/gone/);
    await core.threads.sendQueued(t.id, third.messageId);
    expect(send.mock.calls.map((args) => args[1])).toEqual(["First", "Third"]);
    core.threads.unqueue(t.id, second.messageId);
    expect(core.threads.get(t.id)?.queued).toEqual([]);
    expect(core.db.stmt("SELECT state FROM thread_queue WHERE id = ?").get(second.messageId)).toEqual({ state: "cancelled" });
  });

  it("accepts image-only follow-ups while rejecting empty messages", () => {
    const t = insert("Images");
    const activity = vi.spyOn(core.runs, "threadActivity").mockReturnValue("running");
    try {
      const receipt = core.threads.queueFollowUp({ threadId: t.id, text: "", attachments: ["/tmp/image.png"], requestKey: "image" });
      expect(core.threads.get(t.id)?.queued).toMatchObject([{ id: receipt.messageId, text: "", attachments: ["/tmp/image.png"] }]);
      expect(() => core.threads.queueFollowUp({ threadId: t.id, text: " ", requestKey: "empty" })).toThrow(/message/);
    } finally {
      core.threads.unqueue(t.id, core.threads.get(t.id)!.queued[0]!.id);
      activity.mockRestore();
    }
  });

  it("searches what was said across threads", () => {
    const t = insert("Search me");
    core.db.stmt("INSERT INTO runs (id, thread_id, agent, mode, permission_mode, state, started_at) VALUES (?, ?, 'codex', 'act', 'trusted', 'success', ?)").run("run-search", t.id, Date.now());
    core.ledger.push({ type: "message.completed", runId: "run-search", ts: Date.now(), messageId: "m", role: "assistant", text: "The invoices endpoint now paginates by cursor." });
    core.ledger.flush();
    const hits = core.threads.search("cursor", { projectId: project.id });
    expect(hits.map((h) => h.threadId)).toEqual([t.id]);
    expect(hits[0]?.snippet).toContain("cursor");
  });

  it("checkpoints the tree and restores it, and moves a thread between the checkout and a worktree", async () => {
    const { checkpoints } = await import("@openorc/db");
    const { treeHash } = await import("@openorc/git");
    const t = insert("Restore me");
    const before = await treeHash(root);
    checkpoints.insert(core.db, { threadId: t.id, runId: null, turn: 1, treeSha: before, diffStat: { files: 0, insertions: 0, deletions: 0, untracked: 0 } });
    await writeFile(path.join(root, "scratch.txt"), "temporary\n");
    const diff = await core.review.threadDiff(t, project);
    expect(diff.files.map((f) => f.path)).toEqual(["scratch.txt"]);

    // The uncommitted file travels into the thread's new worktree and leaves the checkout.
    const moved = await core.threads.moveWorkspace(t.id, "worktree");
    expect(moved.workspaceMode).toBe("worktree");
    expect(moved.worktreePath).toContain("thread-restore-me");
    expect(await readFile(path.join(moved.worktreePath as string, "scratch.txt"), "utf8")).toBe("temporary\n");
    await expect(readFile(path.join(root, "scratch.txt"), "utf8")).rejects.toThrow();
    expect((await core.review.threadDiff(moved, project)).files.map((f) => f.path)).toEqual(["scratch.txt"]);

    // And back again.
    const back = await core.threads.moveWorkspace(t.id, "current");
    expect(back.workspaceMode).toBe("current");
    expect(back.worktreePath).toBeNull();
    expect(await readFile(path.join(root, "scratch.txt"), "utf8")).toBe("temporary\n");

    await core.threads.restore(t.id, checkpoints.listForThread(core.db, t.id)[0]?.id as string);
    await expect(readFile(path.join(root, "scratch.txt"), "utf8")).rejects.toThrow();
    expect((await core.review.threadDiff(back, project)).files).toEqual([]);
  });

  it("keeps a worktree that a fork still shares when its parent is deleted", async () => {
    const { access } = await import("node:fs/promises");
    const t = insert("Shared worktree");
    const parent = await core.threads.moveWorkspace(t.id, "worktree");
    const fork = core.threads.fork(parent.id);
    expect(fork.worktreePath).toBe(parent.worktreePath);
    await core.threads.delete(parent.id);
    await access(fork.worktreePath as string);
    await core.threads.delete(fork.id);
    await expect(access(fork.worktreePath as string)).rejects.toThrow();
  });

  it("imports the CLIs' own sessions for the project as threads", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "openorc-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const { claudeProjectDir } = await import("@openorc/agents");
      // The project stores git's resolved root, which on macOS differs from the temp path by a symlink.
      const dir = claudeProjectDir(project.rootPath, home);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      const rows = [
        { type: "user", sessionId: "s-1", cwd: project.rootPath, timestamp: "2026-09-01T10:00:00.000Z", uuid: "u1", message: { role: "user", content: "Tidy the README" } },
        { type: "assistant", sessionId: "s-1", timestamp: "2026-09-01T10:00:05.000Z", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "Tidied." }] } },
      ];
      await writeFile(path.join(dir, "s-1.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const found = await core.imports.importable(project.id);
      expect(found.map((f) => f.sessionId)).toEqual(["s-1"]);
      expect(found[0]?.threadId).toBeNull();
      const [thread] = await core.imports.import(project.id, [{ agent: "claude", path: found[0]?.path as string }]);
      expect(thread?.title).toBe("Tidy the README");
      expect(thread?.importedFrom).toBe(found[0]?.path);
      const summary = core.threads.get(thread?.id as string);
      expect(summary?.unread).toBe(false);
      expect((await core.imports.importable(project.id))[0]?.threadId).toBe(thread?.id);
      expect(core.threads.search("tidied", { projectId: project.id }).map((h) => h.threadId)).toEqual([thread?.id]);
      // Importing again returns the same thread instead of a copy.
      expect((await core.imports.import(project.id, [{ agent: "claude", path: found[0]?.path as string }]))[0]?.id).toBe(thread?.id);
    } finally {
      process.env["HOME"] = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps app settings and schedules", () => {
    expect(core.settings.get().autoDoneDays).toBe(3);
    expect(core.settings.set({ autoDoneDays: null, notifications: false }).notifications).toBe(false);
    expect(core.settings.get().autoDoneDays).toBeNull();
    const s = core.schedules.create({
      projectId: project.id,
      title: "Nightly",
      prompt: "Look around",
      agent: "codex",
      model: null,
      effort: null,
      mode: "plan",
      permissionMode: "trusted",
      workspaceMode: "worktree",
      everyMinutes: 30,
    });
    expect(core.schedules.list(project.id).map((x) => x.id)).toEqual([s.id]);
    const later = core.schedules.update(s.id, { everyMinutes: 60 });
    expect(later.nextRunAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    core.schedules.delete(s.id);
    expect(core.schedules.list(project.id)).toEqual([]);
  });

  it("coalesces simultaneous schedule firings into one thread", async () => {
    const t = insert("Scheduled result");
    const r = runRepo.insert(core.db, { id: "schedule-run", taskId: null, threadId: t.id, agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
    const schedule = core.schedules.create({
      projectId: project.id,
      title: "Daily check",
      prompt: "Check",
      agent: "codex",
      model: null,
      effort: null,
      mode: "plan",
      permissionMode: "trusted",
      workspaceMode: "current",
      everyMinutes: 30,
    });
    let accept!: (value: { thread: Thread; run: typeof r }) => void;
    const start = vi.spyOn(core.threads, "start").mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    try {
      const first = core.schedules.fire(schedule);
      const second = core.schedules.fire(schedule);
      expect(start).toHaveBeenCalledTimes(1);
      accept({ thread: t, run: r });
      expect((await first).id).toBe(t.id);
      expect((await second).id).toBe(t.id);
      expect(core.schedules.list(project.id).find((s) => s.id === schedule.id)?.lastThreadId).toBe(t.id);
    } finally {
      start.mockRestore();
      core.schedules.delete(schedule.id);
    }
  });
});
