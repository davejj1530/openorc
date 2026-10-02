import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle, type AgentLaunchEnvironment, type LiveSettings } from "@openorc/agents";
import { Db, LedgerWriter, checkpoints, orchestration, projects, runs, snapshots, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type AgentEvent, type PermissionPreset, type Project, type RunSpec, type Thread } from "@openorc/protocol";
import { FrameCoalescer } from "../frames.js";
import { RunService, type RunAdapterRegistry, type RunHooks, type StartRunInput } from "./runs.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import { WorkspaceService } from "./workspace.js";
import { ThreadService } from "./threads.js";
import { ShellEnvironment, type EnvSnapshot } from "./shell-environment.js";
import { checkpointRefs } from "./checkpoint-refs.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-run-coordination-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Coordination fixture\n");
  await commitAll(root, "Fixture");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let db: Db;
let ledger: LedgerWriter;
let project: Project;
let service: RunService;
let hooks: RunHooks;
let automaticExit: boolean;
let steerable: boolean;
/** Whether scripted providers can change model and effort on their open session. */
let liveSettings: boolean;
const steerTransport = vi.fn<(text: string, attachments?: string[]) => Promise<"accepted" | "unavailable">>();
const settingsTransport = vi.fn<(settings: LiveSettings) => Promise<void>>();
const followupTransport = vi.fn<(text: string, attachments?: string[]) => Promise<void>>();
const stopTransport = vi.fn<(commandId: string) => Promise<void>>();
const invalidations = vi.fn<(keys: string[]) => void>();
let scripted: Map<string, { handle: RunHandle; finish: () => void }>;
let adapters: RunAdapterRegistry;
let mcp: ReturnType<typeof vi.fn<ConstructorParameters<typeof RunService>[3]>>;
let writers: WorkspaceWriters;
const permissionFolders: string[] = [];
const quiet = { info() {}, warn() {}, error() {} };

beforeEach(() => {
  db = Db.memory();
  ledger = new LedgerWriter(db);
  project = projects.insert(db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  automaticExit = true;
  steerable = false;
  liveSettings = true;
  steerTransport.mockReset().mockResolvedValue("accepted");
  settingsTransport.mockReset().mockResolvedValue(undefined);
  followupTransport.mockReset().mockResolvedValue(undefined);
  stopTransport.mockReset().mockResolvedValue(undefined);
  invalidations.mockReset();
  scripted = new Map();
  const start = (spec: RunSpec, _launch: AgentLaunchEnvironment) => {
    let resolve!: (code: number) => void;
    const done = new Promise<number>((next) => {
      resolve = next;
    });
    let exited = false;
    const finish = () => {
      if (exited) return;
      exited = true;
      handle.emit("exit", 0);
      resolve(0);
    };
    const handle = new RunHandle(spec.runId, {
      send: followupTransport,
      stopCommand: stopTransport,
      ...(spec.agent === "codex" ? { steer: steerTransport, canSteer: () => steerable } : {}),
      ...(liveSettings ? { applySettings: settingsTransport } : {}),
      interrupt() {},
      close() {
        if (automaticExit) finish();
      },
      done,
    });
    scripted.set(spec.runId, { handle, finish });
    return handle;
  };
  adapters = { codex: { start: vi.fn(start) }, claude: { start: vi.fn(start) }, opencode: { start: vi.fn(start) } };
  const environment = new ShellEnvironment({ env: { ...process.env, OPENORC_CLAUDE_BIN: "/fixture/claude", OPENORC_CODEX_BIN: "/fixture/codex" } });
  hooks = {
    environment: () => environment.current(),
    brief: () => "",
    onRunFinished: vi.fn(),
    onThreadTurn: vi.fn(),
    notify: vi.fn(),
    claudeVersion: async () => null,
    onTurnSettled: vi.fn(),
    taskImages: vi.fn(async () => ["/fixture/from-current-document.png"]),
  };
  mcp = vi.fn(async () => ({ port: 0, urlForRun: (id: string) => `http://fixture.invalid/${id}`, revoke: () => {}, close: async () => {} }));
  writers = new WorkspaceWriters();
  service = new RunService(db, ledger, new FrameCoalescer(() => {}), mcp, invalidations, quiet, hooks, adapters, writers);
});
afterEach(async () => {
  for (const session of scripted.values()) session.finish();
  await service.closeAll();
  ledger.close();
  db.close();
  for (const folder of permissionFolders.splice(0)) await rm(folder, { recursive: true, force: true });
});

function taskInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  const task = tasks.insert(db, {
    projectId: project.id,
    title: "Assignment",
    spec: "Captured assignment document",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: "main",
    parentTaskId: null,
  });
  return { scope: { task, thread: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Carry out the assignment", resume: false, ...overrides };
}

function environmentSnapshot(revision: number): EnvSnapshot {
  const env = Object.freeze({
    PATH: `/snapshot/${revision}`,
    OPENORC_CLAUDE_BIN: `/snapshot/${revision}/claude`,
    OPENORC_CODEX_BIN: `/snapshot/${revision}/codex`,
    SNAPSHOT_REVISION: String(revision),
  });
  return Object.freeze({
    revision,
    shell: "/bin/zsh",
    path: env.PATH,
    binaries: Object.freeze({ claude: env.OPENORC_CLAUDE_BIN, codex: env.OPENORC_CODEX_BIN, opencode: null }),
    env,
  });
}

function emit(runId: string, event: AgentEvent): void {
  scripted.get(runId)!.handle.emit("event", event);
}

describe("provider capacity failures", () => {
  const message = "Selected model is at capacity. Please try a different model.";

  it.each(["high"])("resumes a failed thread with the selected %s effort when input arrives through send", async (effort) => {
    const thread = threads.insert(db, { projectId: project.id, title: "Capacity", agent: "codex", model: "gpt-6-astra", effort: "xhigh", mode: "act", permissionMode: "trusted" });
    const run = await service.start({
      scope: { task: null, thread },
      project,
      agent: "codex",
      model: thread.model!,
      effort: "xhigh",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Continue",
      resume: false,
    });
    emit(run.id, { type: "session.started", runId: run.id, ts: Date.now(), agent: "codex", externalSessionId: "existing-thread", model: thread.model });
    emit(run.id, { type: "error", runId: run.id, ts: Date.now(), message, fatal: true });
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "failed", status: "error", durationMs: 5633 });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
    threads.update(db, thread.id, { effort });

    await service.send(run.id, "Try again");
    const retry = runs.listForThread(db, thread.id).at(-1)!;
    emit(retry.id, { type: "turn.completed", runId: retry.id, ts: Date.now(), turnId: "retry", status: "success", durationMs: 1 });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledTimes(2));
    expect(hooks.onTurnSettled).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), project, expect.objectContaining({ status: "success", error: null }));
    expect(retry.id).not.toBe(run.id);
    expect(followupTransport).not.toHaveBeenCalled();
    expect(adapters.codex.start).toHaveBeenLastCalledWith(expect.objectContaining({ resumeSessionId: "existing-thread", model: "gpt-6-astra", effort, prompt: "Try again" }), expect.anything());
    await service.closeAndWait(retry.id);
    expect(runs.get(db, retry.id)).toMatchObject({ state: "success", error: null });
  });
});

describe("live settings", () => {
  /** A thread whose first turn has finished, so its process is idle. */
  async function idleThread(settings: Partial<Thread> = {}) {
    const thread = threads.insert(db, { projectId: project.id, title: "Live", agent: "codex", model: "gpt-5.6-sol", effort: "medium", mode: "act", permissionMode: "trusted", ...settings });
    const run = await service.start({
      scope: { task: null, thread },
      project,
      agent: thread.agent,
      model: thread.model!,
      effort: thread.effort ?? undefined,
      fastMode: thread.fastMode,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      prompt: "Begin",
      resume: false,
    });
    emit(run.id, { type: "session.started", runId: run.id, ts: Date.now(), agent: "codex", externalSessionId: "session-1", model: thread.model });
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "first", status: "success", durationMs: 1 });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
    return { thread, run };
  }
  const systemNotices = (runId: string) => {
    ledger.flush();
    return (
      db
        .stmt("SELECT COALESCE(a.content, e.payload) AS payload FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload' WHERE e.run_id = ? AND e.kind = 'message.completed'")
        .all(runId) as { payload: string }[]
    )
      .map((row) => JSON.parse(row.payload) as { role: string; text: string })
      .filter((message) => message.role === "system")
      .map((message) => message.text);
  };

  it("changes the model and effort on the open session and records them on the run", async () => {
    const { thread, run } = await idleThread();
    threads.update(db, thread.id, { model: "gpt-6-astra", effort: "high" });
    await service.send(run.id, "Carry on");
    expect(settingsTransport).toHaveBeenCalledExactlyOnceWith({ model: "gpt-6-astra", effort: "high" });
    expect(followupTransport).toHaveBeenCalledExactlyOnceWith("Carry on", undefined);
    expect(adapters.codex.start).toHaveBeenCalledOnce();
    expect(runs.listForThread(db, thread.id)).toHaveLength(1);
    expect(runs.get(db, run.id)).toMatchObject({ model: "gpt-6-astra", effort: "high" });
    expect(systemNotices(run.id)).toEqual(["Switched to gpt-6-astra at high effort."]);
    expect(invalidations).toHaveBeenCalledWith(expect.arrayContaining([`runs:thread:${thread.id}`]));
    // The run now matches the thread: the next message changes nothing.
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "second", status: "success", durationMs: 1 });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledTimes(2));
    await service.send(run.id, "And again");
    expect(settingsTransport).toHaveBeenCalledOnce();
    expect(adapters.codex.start).toHaveBeenCalledOnce();
  });

  it("restarts with the new settings when the provider refuses the change", async () => {
    const { thread, run } = await idleThread();
    settingsTransport.mockRejectedValueOnce(new Error("Unknown model"));
    threads.update(db, thread.id, { model: "gpt-6-astra" });
    await service.send(run.id, "Carry on");
    expect(settingsTransport).toHaveBeenCalledOnce();
    expect(followupTransport).not.toHaveBeenCalled();
    expect(adapters.codex.start).toHaveBeenCalledTimes(2);
    expect(adapters.codex.start).toHaveBeenLastCalledWith(expect.objectContaining({ resumeSessionId: "session-1", model: "gpt-6-astra", effort: "medium", prompt: "Carry on" }), expect.anything());
    expect(runs.get(db, run.id)).toMatchObject({ model: "gpt-5.6-sol", effort: "medium" });
    expect(systemNotices(run.id)).toEqual([]);
  });

  it("restarts to reset effort to the provider default", async () => {
    const { thread, run } = await idleThread();
    threads.update(db, thread.id, { effort: null });
    await service.send(run.id, "Carry on");
    expect(settingsTransport).not.toHaveBeenCalled();
    expect(adapters.codex.start).toHaveBeenCalledTimes(2);
    const restarted = vi.mocked(adapters.codex.start).mock.lastCall![0];
    expect(restarted).toMatchObject({ model: "gpt-5.6-sol", prompt: "Carry on" });
    expect(restarted.effort).toBeUndefined();
  });

  /** Codex discovery answering with one Fast-capable model, so the eligibility check can pass. */
  async function fastCapableCatalog() {
    const discovery = vi.spyOn(CodexAdapter.prototype, "listModels").mockResolvedValue([
      {
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "Astra",
        description: "",
        isDefault: true,
        hidden: false,
        efforts: ["medium", "high"],
        defaultEffort: "medium",
        serviceTiers: [{ id: "priority", name: "Fast", description: "Higher usage" }],
      },
    ]);
    await service.models("codex");
    discovery.mockRestore();
  }

  it("turns Fast on and off on the open session once the account and model allow it", async () => {
    await fastCapableCatalog();
    const { thread, run } = await idleThread({ model: "gpt-6-astra" });
    threads.update(db, thread.id, { fastMode: true });
    await service.send(run.id, "Faster");
    expect(settingsTransport).toHaveBeenCalledExactlyOnceWith({ fastMode: true });
    expect(adapters.codex.start).toHaveBeenCalledOnce();
    expect(runs.get(db, run.id)).toMatchObject({ model: "gpt-6-astra", effort: "medium", fastMode: true });
    expect(systemNotices(run.id)).toEqual(["Switched to gpt-6-astra at medium effort, Fast on."]);
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "second", status: "success", durationMs: 1 });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledTimes(2));
    threads.update(db, thread.id, { fastMode: false });
    await service.send(run.id, "Standard");
    expect(settingsTransport).toHaveBeenLastCalledWith({ fastMode: false });
    expect(runs.get(db, run.id)).toMatchObject({ fastMode: false });
    expect(systemNotices(run.id).at(-1)).toBe("Switched to gpt-6-astra at medium effort, Fast off.");
  });

  it("refuses Fast when support is unconfirmed before touching the session", async () => {
    const { thread, run } = await idleThread();
    threads.update(db, thread.id, { fastMode: true });
    await expect(service.send(run.id, "Faster")).rejects.toThrow("Fast mode support has not been confirmed");
    expect(settingsTransport).not.toHaveBeenCalled();
    expect(followupTransport).not.toHaveBeenCalled();
    expect(adapters.codex.start).toHaveBeenCalledOnce();
  });

  it.each([
    ["mode", { mode: "plan" as const }],
    ["permission mode", { permissionMode: "autonomous" as const }],
  ])("restarts for a %s change even when the model changed too", async (_what, patch) => {
    const { thread, run } = await idleThread();
    threads.update(db, thread.id, { model: "gpt-6-astra", ...patch });
    await service.send(run.id, "Carry on");
    expect(settingsTransport).not.toHaveBeenCalled();
    expect(adapters.codex.start).toHaveBeenCalledTimes(2);
    expect(adapters.codex.start).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-6-astra", ...patch }), expect.anything());
  });
});

function permissionTeam(permissionMode: PermissionPreset = "trusted", mode: "act" | "plan" = "act"): Thread {
  const thread = threads.insert(db, { projectId: project.id, title: "Permission team", agent: "codex", model: "fixture", mode, permissionMode });
  const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Permissions",
      limits: DEFAULT_TEAM_LIMITS,
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
        { key: "manager", name: "Manager", managerKey: "lead", responsibility: "Manage", settings: { ...settings, agent: "claude" } },
        { key: "worker", name: "Worker", managerKey: "manager", responsibility: "Implement", settings },
      ],
    },
  });
  orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  return thread;
}
function permissionLead(thread: Thread): StartRunInput {
  return {
    scope: { task: null, thread },
    project,
    agent: "codex",
    model: "fixture",
    mode: thread.mode,
    permissionMode: thread.permissionMode,
    prompt: "Hold the permission test",
    resume: false,
    teamAttemptId: randomUUID(),
  };
}
async function permissionChild(thread: Thread, agent: "codex" | "claude", parentTaskId: string | null = null): Promise<StartRunInput> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "openorc-permission-writer-"));
  permissionFolders.push(folder);
  const destination = path.join(folder, "checkout");
  await git(root, ["worktree", "add", "--detach", destination, "HEAD"]);
  const task = tasks.insert(db, {
    projectId: project.id,
    threadId: thread.id,
    title: "Team member",
    spec: "Keep work isolated",
    priority: "none",
    labels: [],
    workspaceMode: "worktree",
    baseRef: "main",
    parentTaskId,
  });
  return {
    scope: { task: tasks.update(db, task.id, { worktreePath: destination }), thread: null },
    project,
    agent,
    model: "fixture",
    mode: thread.mode,
    permissionMode: thread.permissionMode,
    prompt: "Hold this member",
    resume: false,
    teamAttemptId: randomUUID(),
    collectTaskImages: false,
  };
}

describe("launch environment admission", () => {
  it("keeps one immutable revision across awaited preparation and gives the next run the new revision", async () => {
    const first = environmentSnapshot(7);
    const second = environmentSnapshot(8);
    let current = first;
    hooks.environment = () => current;
    let releaseImages!: (paths: string[]) => void;
    hooks.taskImages = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          releaseImages = resolve;
        }),
    );

    const starting = service.start(taskInput());
    await vi.waitFor(() => expect(hooks.taskImages).toHaveBeenCalledTimes(1));
    current = second;
    releaseImages([]);
    const admitted = await starting;

    expect(adapters.codex.start).toHaveBeenLastCalledWith(expect.objectContaining({ runId: admitted.id }), expect.objectContaining({ revision: 7, binary: "/snapshot/7/codex", env: first.env }));
    await service.closeAndWait(admitted.id);

    hooks.taskImages = vi.fn(async () => []);
    const next = await service.start(taskInput());
    expect(adapters.codex.start).toHaveBeenLastCalledWith(expect.objectContaining({ runId: next.id }), expect.objectContaining({ revision: 8, binary: "/snapshot/8/codex", env: second.env }));
  });
});

describe("coordinator live direction transport", () => {
  it.each(["codex", "claude"] as const)("announces host permission waits for %s after registration without resolving questions", async (agent) => {
    const thread = threads.insert(db, { projectId: project.id, title: "Approval fixture", agent, model: "fixture", mode: "act", permissionMode: "trusted" });
    const run = await service.start({ ...permissionLead(thread), agent, teamAttemptId: undefined });
    hooks.onApprovalRequested = vi.fn((event) => {
      expect(service.pending()).toEqual(expect.arrayContaining([expect.objectContaining({ runId: event.runId, approvalId: event.approvalId })]));
    });
    const external = service.requestApproval(run.id, "external", "Bash", { command: "echo check" });
    expect(hooks.onApprovalRequested).toHaveBeenCalledTimes(1);
    expect(hooks.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "approval", threadId: thread.id }));
    service.resolveApproval(run.id, "external", "allow");
    await external;
    // A notification sink must never break the actual pending permission flow.
    hooks.onApprovalRequested = () => {
      throw Error("notification sink unavailable");
    };
    const question = service.requestApproval(run.id, "question", "AskUserQuestion", { questions: [{ question: "Which option?" }] });
    expect(service.pending()).toEqual([expect.objectContaining({ runId: run.id, approvalId: "question" })]);
    service.resolveApproval(run.id, "question", "allow", { choice: ["A"] });
    await expect(question).resolves.toEqual({ decision: "allow", answers: { choice: ["A"] } });
  });

  it("does not announce automatically allowed requests", async () => {
    const thread = permissionTeam("autonomous");
    const run = await service.start(permissionLead(thread));
    hooks.onApprovalRequested = vi.fn();
    await expect(service.requestApproval(run.id, "automatic", "Bash", { command: "echo check" })).resolves.toEqual({ decision: "allow" });
    expect(hooks.onApprovalRequested).not.toHaveBeenCalled();
    expect(hooks.notify).not.toHaveBeenCalled();
  });

  it("refreshes controls when provider readiness changes without an assistant reply", async () => {
    const thread = permissionTeam();
    const run = await service.start(permissionLead(thread));
    invalidations.mockClear();
    steerable = true;
    emit(run.id, { type: "raw", runId: run.id, ts: Date.now(), agent: "codex", payload: { method: "turn/started" } });
    expect(invalidations).toHaveBeenCalledWith(expect.arrayContaining([`thread:${thread.id}`]));
    expect(service.canSteer(run.id)).toBe(true);
    steerable = false;
    emit(run.id, { type: "raw", runId: run.id, ts: Date.now(), agent: "codex", payload: { method: "item/started", params: { item: { type: "contextCompaction" } } } });
    expect(invalidations).toHaveBeenCalledTimes(2);
    expect(service.canSteer(run.id)).toBe(false);
    emit(run.id, { type: "raw", runId: run.id, ts: Date.now(), agent: "codex", payload: { method: "thread/tokenUsage/updated" } });
    expect(invalidations).toHaveBeenCalledTimes(2);
  });

  it("keeps delivery within its run and records one canonical transcript marker", async () => {
    const thread = permissionTeam();
    const run = await service.start(permissionLead(thread));
    steerable = true;
    threads.update(db, thread.id, { model: "next-model", effort: "high", fastMode: true });
    hooks.assertSend = () => {
      throw new Error("ordinary send must not bypass the mailbox");
    };
    const direction = { id: "retained-direction", text: "Use these constraints. ".repeat(500), attachments: ["/tmp/direction.png"] };
    service.recordTeamDirection(run.id, direction);
    service.recordTeamDirection(run.id, direction);
    await expect(service.steer(run.id, direction.text, direction.attachments)).resolves.toBe("accepted");
    expect(steerTransport).toHaveBeenCalledExactlyOnceWith(direction.text, direction.attachments);
    expect(followupTransport).not.toHaveBeenCalled();
    expect(adapters.codex.start).toHaveBeenCalledTimes(1);
    expect(runs.listForThread(db, thread.id)).toHaveLength(1);
    const markers = db
      .stmt(
        "SELECT COALESCE(a.content, e.payload) AS payload FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload' WHERE e.run_id = ? AND e.kind = 'message.completed' AND json_extract(COALESCE(a.content, e.payload), '$.messageId') = ?",
      )
      .all(run.id, "team-direction:retained-direction") as { payload: string }[];
    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0]!.payload)).toMatchObject({ role: "user", text: direction.text, attachments: direction.attachments });
  });

  it("refuses updates during startup and turns, then atomically fences new work while draining an idle session", async () => {
    const input = permissionLead(permissionTeam());
    const starting = service.start(input);
    expect(service.prepareForUpdate()).toBe(false);
    const run = await starting;
    expect(service.prepareForUpdate()).toBe(false);
    expect(service.isLive(run.id)).toBe(true);
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "done", durationMs: 1, status: "success" });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalled());
    expect(service.prepareForUpdate()).toBe(true);
    await expect(service.send(run.id, "A racing next turn")).rejects.toThrow("closing");
    await expect(service.start(input)).rejects.toThrow("closing");
    await expect(service.compact(run.id)).rejects.toThrow("closing");
    await service.closeAll();
    expect(service.isLive(run.id)).toBe(false);
    expect(runs.get(db, run.id)?.state).toBe("success");
  });
});

describe("live team permissions", () => {
  it("applies the shared gate to lead, manager and grandchild, scopes duplicate approval IDs, and preserves questions and other teams", async () => {
    const thread = permissionTeam();
    const managerInput = await permissionChild(thread, "claude");
    const childInput = await permissionChild(thread, "codex", managerInput.scope.task!.id);
    const other = permissionTeam();
    const unrelatedInput = await permissionChild(other, "claude");
    const owned = await Promise.all([service.start(permissionLead(thread)), service.start(managerInput), service.start(childInput)]);
    const unrelated = await service.start(unrelatedInput);
    const answers = owned.map((run) => service.requestApproval(run.id, "same-tool-id", "Bash", {}));
    const questions = owned.map((run) => service.requestApproval(run.id, "same-question-id", "AskUserQuestion", {}));
    const otherAnswer = service.requestApproval(unrelated.id, "same-tool-id", "Bash", {});
    const changed = threads.update(db, thread.id, { permissionMode: "autonomous" });
    expect(service.applyThreadPermissions(changed)).toMatchObject({ requested: "autonomous", effective: "autonomous", pendingRestart: false });
    await expect(Promise.all(answers)).resolves.toEqual(owned.map(() => ({ decision: "allow" })));
    expect(service.pending().filter((item) => item.approvalId === "same-question-id")).toHaveLength(3);
    expect(
      service
        .pending()
        .filter((item) => item.approvalId === "same-tool-id")
        .map((item) => item.runId),
    ).toEqual([unrelated.id]);
    expect(runs.get(db, unrelated.id)?.permissionMode).toBe("trusted");
    expect(
      service
        .threadPermissions(thread.id)
        .runs.map((item) => item.runId)
        .sort(),
    ).toEqual(owned.map((item) => item.id).sort());
    for (const run of owned) service.resolveApproval(run.id, "same-question-id", "allow", { destination: [run.id] });
    await expect(Promise.all(questions)).resolves.toEqual(owned.map((run) => ({ decision: "allow", answers: { destination: [run.id] } })));
    service.resolveApproval(unrelated.id, "same-tool-id", "deny");
    await expect(otherAnswer).resolves.toEqual({ decision: "deny" });
    expect(vi.mocked(adapters.codex.start).mock.calls.length + vi.mocked(adapters.claude.start).mock.calls.length).toBe(4);
  });

  it.each(["trusted", "autonomous"] as const)("truthfully tightens the app gate against native %s and reopens pending tool requests without answering questions", async (native) => {
    const thread = permissionTeam(native);
    const run = await service.start(permissionLead(thread));
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "autonomous" }));
    const tightened = service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "review" }));
    expect(tightened).toMatchObject({
      requested: "review",
      effective: native,
      pendingRestart: true,
      runs: [{ runId: run.id, effective: native, providerPermissionMode: native, pendingRestart: true }],
    });
    expect(runs.get(db, run.id)?.permissionMode).toBe(native);
    const parked = service.requestApproval(run.id, "held", "Bash", {});
    const question = service.requestApproval(run.id, "question", "AskUserQuestion", {});
    expect(service.pending().map((item) => item.approvalId)).toEqual(["held", "question"]);
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "autonomous" }));
    await expect(parked).resolves.toEqual({ decision: "allow" });
    expect(service.pending().map((item) => item.approvalId)).toEqual(["question"]);
    service.resolveApproval(run.id, "question", "deny");
    await question;
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "review" }));
    automaticExit = false;
    await expect(service.closeAndWait(run.id, 10)).rejects.toThrow(/still closing/);
    expect(service.threadPermissions(thread.id).pendingRestart).toBe(true);
    scripted.get(run.id)!.finish();
    await service.closeAndWait(run.id);
    expect(service.threadPermissions(thread.id)).toEqual({ mode: { requested: "act", effective: "act", pending: false }, requested: "review", effective: "review", pendingRestart: false, runs: [] });
    const restarted = await service.start(permissionLead(threads.get(db, thread.id)!));
    expect(vi.mocked(adapters.codex.start).mock.lastCall?.[0].permissionMode).toBe("review");
    expect(service.threadPermissions(thread.id).runs[0]).toMatchObject({ runId: restarted.id, effective: "review", pendingRestart: false });
  });

  it("reports the Plan ceiling and mixed native policies while denying forbidden Plan commands", async () => {
    const thread = permissionTeam("autonomous", "plan");
    const lead = await service.start(permissionLead(thread));
    const plan = service.threadPermissions(thread.id);
    expect(plan).toMatchObject({ requested: "autonomous", effective: "review", pendingRestart: false, runs: [{ mode: "plan", effective: "review", providerPermissionMode: "review" }] });
    const question = service.requestApproval(lead.id, "plan-tool", "Bash", {});
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "review" }));
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "autonomous" }));
    expect(service.pending()).toHaveLength(0);
    await expect(question).resolves.toMatchObject({ decision: "deny" });
    const child = await permissionChild(thread, "claude");
    await service.start({ ...child, mode: "act" });
    expect(service.threadPermissions(thread.id)).toMatchObject({ requested: "autonomous", effective: null, pendingRestart: true, mode: { requested: "plan", effective: null, pending: true } });
  });

  it.each([
    ["codex", "trusted"],
    ["codex", "autonomous"],
    ["claude", "trusted"],
    ["claude", "autonomous"],
  ] as const)("holds automatic grants for requested Plan while %s retains its actual Act / %s process", async (agent, native) => {
    const thread = permissionTeam(native);
    const input = { ...permissionLead(thread), agent };
    const run = await service.start(input);
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "autonomous" }));
    const plan = service.applyThreadPermissions(threads.update(db, thread.id, { mode: "plan" }));
    expect(plan).toMatchObject({ mode: { requested: "plan", effective: "act", pending: true }, requested: "autonomous", effective: native, pendingRestart: true });
    expect(runs.get(db, run.id)).toMatchObject({ mode: "act", permissionMode: native });
    const external = service.requestApproval(run.id, "after-plan", "Bash", {});
    const question = service.requestApproval(run.id, "choose", "AskUserQuestion", {});
    service.applyThreadPermissions(threads.get(db, thread.id)!);
    expect(service.pending().map((item) => item.approvalId)).toEqual(["after-plan", "choose"]);
    expect(service.applyThreadPermissions(threads.update(db, thread.id, { mode: "act" })).mode).toEqual({ requested: "act", effective: "act", pending: false });
    await expect(external).resolves.toMatchObject({ decision: "allow" });
    expect(service.pending().map((item) => item.approvalId)).toEqual(["choose"]);
    service.resolveApproval(run.id, "choose", "deny");
    await question;
    service.applyThreadPermissions(threads.update(db, thread.id, { mode: "plan" }));
    automaticExit = false;
    await expect(service.closeAndWait(run.id, 10)).rejects.toThrow(/still closing/);
    expect(service.threadPermissions(thread.id).mode?.pending).toBe(true);
    scripted.get(run.id)!.finish();
    await service.closeAndWait(run.id);
    expect(service.threadPermissions(thread.id)).toMatchObject({ mode: { requested: "plan", effective: "plan", pending: false }, effective: "review", pendingRestart: false });
    const next = await service.start({ ...permissionLead(threads.get(db, thread.id)!), agent });
    expect(runs.get(db, next.id)?.mode).toBe("plan");
    expect(vi.mocked(adapters[agent].start).mock.lastCall![0].permissionMode).toBe("review");
    expect(service.applyThreadPermissions(threads.update(db, thread.id, { mode: "act" })).mode).toEqual({ requested: "act", effective: "plan", pending: true });
    const planRequest = service.requestApproval(next.id, "still-plan", "Bash", {});
    expect(service.pending()).toHaveLength(0);
    await expect(planRequest).resolves.toMatchObject({ decision: "deny" });
  });

  it.each(["lead", "worker"] as const)("uses the latest requested policy for a %s whose MCP startup was already pending", async (scope) => {
    const thread = permissionTeam("autonomous");
    const input = scope === "lead" ? permissionLead(thread) : await permissionChild(thread, "claude");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mcp.mockImplementationOnce(async () => {
      await gate;
      return { port: 0, urlForRun: () => "http://fixture.invalid", revoke: () => {}, close: async () => {} };
    });
    const starting = service.start(input);
    await vi.waitFor(() => expect(mcp).toHaveBeenCalledOnce());
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "review" }));
    release();
    const run = await starting;
    expect(vi.mocked(adapters[input.agent as "codex" | "claude"].start).mock.lastCall?.[0].permissionMode).toBe("review");
    expect(runs.get(db, run.id)?.permissionMode).toBe("review");
    expect(service.threadPermissions(thread.id)).toMatchObject({ requested: "review", effective: "review", pendingRestart: false });
  });

  it("keeps ordinary delegated task policies unchanged and rejects inconsistent team ownership", async () => {
    const thread = threads.insert(db, { projectId: project.id, title: "Ordinary thread", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    const input = await permissionChild(thread, "claude");
    delete input.teamAttemptId;
    const child = await service.start(input);
    service.applyThreadPermissions(threads.update(db, thread.id, { permissionMode: "autonomous" }));
    expect(runs.get(db, child.id)?.permissionMode).toBe("trusted");
    const team = permissionTeam();
    const teamInput = await permissionChild(team, "codex");
    await service.start(teamInput);
    db.stmt("UPDATE tasks SET thread_id = NULL WHERE id = ?").run(teamInput.scope.task!.id);
    expect(() => service.assertThreadPermissions(team.id)).toThrow(/inconsistent ownership/);
    expect(threads.get(db, team.id)?.permissionMode).toBe("trusted");
  });
});

describe("coordinator run seams", () => {
  it("runs independently through checkout aliases and only yields idle sessions for exclusive operations", async () => {
    const alias = `${root}-alias`;
    await symlink(root, alias);
    try {
      const thread = threads.insert(db, { projectId: project.id, title: "Resident lead", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
      const first = await service.start({ scope: { task: null, thread }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Coordinate", resume: false });
      const second = await service.start(taskInput({ project: { ...project, rootPath: alias }, agent: "claude" }));
      expect(service.isLive(first.id)).toBe(true);
      expect(service.isLive(second.id)).toBe(true);
      emit(first.id, { type: "turn.completed", runId: first.id, ts: Date.now(), turnId: "idle", status: "success", durationMs: 1 });
      await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
      // One idle session cannot make another session's live reservation look available.
      expect(await writers.reason([root])).toMatch(/in use/);
      await expect(writers.acquire(root, "review commit")).rejects.toThrow(/in use/);
      expect(service.isLive(first.id)).toBe(false);
      expect(service.isLive(second.id)).toBe(true);
      await service.closeAndWait(second.id);
      await writers.withLease(root, "review commit", async () => {});
    } finally {
      await rm(alias);
    }
  });

  it.each(["current", "worktree"] as const)("starts and continues parallel threads in a %s workspace, including a fork sharing it", async (workspaceMode) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-parallel-threads-"));
    permissionFolders.push(dataDir);
    const workspaces = new WorkspaceService(db, { dataDir }, quiet, writers);
    const conversations = new ThreadService(db, service, workspaces, invalidations, quiet, async () => null, writers);
    const input = {
      projectId: project.id,
      agent: "codex" as const,
      model: "fixture",
      effort: undefined,
      mode: "act" as const,
      permissionMode: "trusted" as const,
      workspaceMode,
      prompt: "Work in parallel",
      attachments: [],
      title: undefined,
    };
    const [first, second] = await Promise.all([conversations.start(input), conversations.start(input)]);
    const fork = conversations.fork(first.thread.id);
    const forkRun = await conversations.continueThread(fork.id, input);
    expect(fork.worktreePath).toBe(first.thread.worktreePath);
    for (const thread of [first.thread, second.thread, fork]) expect(service.threadActivity(thread.id)).toBe("running");
    await expect(conversations.continueThread(first.thread.id, input)).rejects.toThrow(/current turn/);

    // Checkpoint both overlapping sessions without closing either provider or touching the real index.
    for (const run of [first.run, forkRun]) emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "done", status: "success", durationMs: 1 });
    await vi.waitFor(() => {
      expect(service.threadActivity(first.thread.id)).toBe("idle");
      expect(service.threadActivity(fork.id)).toBe("idle");
      expect(checkpoints.listForThread(db, first.thread.id)).toHaveLength(1);
      expect(checkpoints.listForThread(db, fork.id)).toHaveLength(1);
    });
    const resumed = await conversations.continueThread(first.thread.id, input);
    expect(service.isLive(resumed.id)).toBe(true);
    expect(service.isLive(second.run.id)).toBe(true);
    expect(service.isLive(forkRun.id)).toBe(true);
    await service.send(forkRun.id, "Continue beside the other thread");
    expect(service.threadActivity(fork.id)).toBe("running");

    // Delegated work in the local checkout can also start beside active conversations.
    const task = taskInput().scope.task!;
    await conversations.startTask(task, first.thread, "current");
    expect(service.liveRunForTask(task.id)).not.toBeNull();
    await workspaces.shutdown();
  });

  it("inherits setup ownership without a gap and retains it until process completion after exit notification", async () => {
    automaticExit = false;
    const preparation = await writers.acquire(root, "task preparation");
    const run = await service.start(taskInput({ workspaceLease: preparation }));
    preparation.release();
    scripted.get(run.id)!.handle.emit("exit", 0);
    await expect(service.closeAndWait(run.id, 10)).rejects.toThrow("still closing");
    await expect(writers.acquire(root, "review commit")).rejects.toThrow(/task preparation/);
    expect(service.isLive(run.id)).toBe(true);
    scripted.get(run.id)!.finish();
    await service.closeAndWait(run.id);
    await writers.withLease(root, "review commit", async () => {});
  });

  it("releases a setup-inherited reservation after startup fails before provider launch", async () => {
    const preparation = await writers.acquire(root, "task preparation");
    try {
      await expect(
        service.start(
          taskInput({
            workspaceLease: preparation,
            onCreated() {
              throw new Error("Binding failed");
            },
          }),
        ),
      ).rejects.toThrow("Binding failed");
    } finally {
      preparation.release();
    }
    await writers.withLease(root, "retry", async () => {});
  });

  it("settles a provider launch failure once and frees its acquired writer lease", async () => {
    const input = taskInput();
    vi.mocked(adapters.codex.start).mockImplementationOnce(() => {
      throw new Error("Provider launch failed");
    });

    await expect(service.start(input)).rejects.toThrow("Provider launch failed");
    expect(runs.listForTask(db, input.scope.task!.id)).toEqual([expect.objectContaining({ state: "error", error: "Provider launch failed", endedAt: expect.any(Number) })]);
    expect(hooks.onTurnSettled).toHaveBeenCalledExactlyOnceWith(expect.anything(), input.scope, project, {
      status: "error",
      snapshotId: null,
      error: "Provider launch failed",
    });
    expect(tasks.get(db, input.scope.task!.id)?.status).toBe("backlog");
    await writers.withLease(root, "retry after launch failure", async () => {});
  });

  it("publishes incoming progress synchronously before any event-finalization microtask", async () => {
    const input = taskInput();
    const run = await service.start(input);
    emit(run.id, { type: "message.completed", runId: run.id, ts: Date.now(), messageId: "progress", role: "assistant", text: "Working on the requested task." });
    expect(service.taskProgress(input.scope.task!.id)).toMatchObject({ runId: run.id, latestMessage: "Working on the requested task." });
  });

  it("rejects unsupported providers before image discovery, row insertion, or MCP startup", async () => {
    const input = taskInput({ agent: "acp" });
    await expect(service.start(input)).rejects.toThrow("no executable adapter");
    expect(hooks.taskImages).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
    expect(runs.listForTask(db, input.scope.task!.id)).toHaveLength(0);
  });

  it.each(["codex", "claude"] as const)("binds %s before exposing MCP and uses captured attachments and instructions", async (agent) => {
    hooks.browserAvailable = true;
    let bound = false;
    const input = taskInput({
      agent,
      collectTaskImages: false,
      attachments: ["/fixture/captured.png"],
      systemPromptAppendix: "Use only your assigned team members.",
      onCreated(run) {
        expect(runs.get(db, run.id)).not.toBeNull();
        expect(mcp).not.toHaveBeenCalled();
        expect(adapters[agent].start).not.toHaveBeenCalled();
        bound = true;
      },
    });
    mcp.mockImplementationOnce(async () => {
      expect(bound).toBe(true);
      return { port: 0, urlForRun: (id: string) => `http://fixture.invalid/${id}`, revoke: () => {}, close: async () => {} };
    });
    const run = await service.start(input);
    expect(hooks.taskImages).not.toHaveBeenCalled();
    expect(adapters[agent].start).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, attachments: ["/fixture/captured.png"], systemPromptAppendix: expect.stringContaining("Use only your assigned team members.") }),
      expect.objectContaining({ revision: expect.any(Number), binary: expect.any(String), env: expect.any(Object) }),
    );
    expect(adapters[agent === "codex" ? "claude" : "codex"].start).not.toHaveBeenCalled();
    const spec = vi.mocked(adapters[agent].start).mock.calls[0]![0];
    expect(spec.systemPromptAppendix).toContain("use OpenOrc's browser tool first");
    expect(spec.internalMcp?.toolNames).toContain("browser");
  });

  it("fences a stop while MCP startup is awaiting without leaving a starting row", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mcp.mockImplementationOnce(async () => {
      await gate;
      return { port: 0, urlForRun: () => "http://fixture.invalid", revoke: () => {}, close: async () => {} };
    });
    let admitted = true;
    const input = taskInput({
      assertCanStart() {
        if (!admitted) throw new Error("Execution stopped");
      },
    });
    const starting = service.start(input);
    await vi.waitFor(() => expect(mcp).toHaveBeenCalledOnce());
    admitted = false;
    release();
    await expect(starting).rejects.toThrow("Execution stopped");
    expect(adapters.codex.start).not.toHaveBeenCalled();
    expect(runs.listForTask(db, input.scope.task!.id)[0]).toMatchObject({ state: "error", endedAt: expect.any(Number) });
  });

  it.each(["claude"] as const)("waits for %s task capture before exit finalization and callbacks", async (agent) => {
    const input = taskInput({ agent });
    const run = await service.start(input);
    const order: string[] = [];
    hooks.onTurnSettled = vi.fn((_run, _scope, _project, outcome) => {
      expect(outcome).toMatchObject({ status: "success", snapshotId: expect.any(String), error: null });
      expect(snapshots.get(db, outcome.snapshotId!)).toMatchObject({ runId: run.id });
      order.push("settled");
    });
    hooks.onRunFinished = vi.fn(() => {
      order.push("finished");
    });
    emit(run.id, { type: "session.started", runId: run.id, ts: Date.now(), agent, externalSessionId: "fixture-session", model: "fixture" });
    emit(run.id, { type: "message.completed", runId: run.id, ts: Date.now(), messageId: "reply", role: "assistant", text: "Assignment complete" });
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "one", status: "success", durationMs: 1 });
    scripted.get(run.id)!.finish();
    expect(order).toEqual([]);
    expect(service.isLive(run.id)).toBe(true);
    await service.closeAndWait(run.id);
    expect(order).toEqual(["settled", "finished"]);
    expect(service.isLive(run.id)).toBe(false);
    expect(runs.get(db, run.id)).toMatchObject({ state: "success", resultText: "Assignment complete", endedAt: expect.any(Number) });
  });

  it.skipIf(process.platform === "win32")("only checkpoints and notifies for the parent turn when Codex streams child completions", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "openorc-child-completion-"));
    permissionFolders.push(folder);
    const binary = path.join(folder, "codex");
    await writeFile(
      binary,
      `#!${process.execPath}
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = (method, params) => send({ method, params });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  send({ id: request.id, result: request.method === "thread/start" ? { thread: { id: "parent-thread" } } : {} });
  if (request.method !== "turn/start") return;
  notify("turn/started", { threadId: "parent-thread", turn: { id: "parent-turn" } });
  notify("item/completed", { threadId: "parent-thread", turnId: "parent-turn", item: { id: "progress", type: "agentMessage", text: "I will continue checking." } });
  notify("turn/started", { threadId: "child-thread", turn: { id: "child-turn" } });
  notify("item/completed", { threadId: "child-thread", turnId: "child-turn", item: { id: "child-reply", type: "agentMessage", text: "Child done" } });
  notify("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } });
  notify("item/completed", { threadId: "parent-thread", turnId: "parent-turn", item: { id: "final", type: "agentMessage", text: "Parent done" } });
  notify("turn/completed", { threadId: "parent-thread", turn: { id: "parent-turn", status: "completed" } });
});
`,
      { mode: 0o755 },
    );
    const environment = new ShellEnvironment({ env: { ...process.env, OPENORC_CODEX_BIN: binary } });
    hooks.environment = () => environment.current();
    adapters.codex = new CodexAdapter({ onApproval: async () => "deny" });
    const settled = new Promise<void>((resolve) => {
      hooks.onTurnSettled = vi.fn(() => resolve());
    });
    const thread = threads.insert(db, { projectId: project.id, title: "Parent", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    await service.start({ scope: { task: null, thread }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Keep working", resume: false });

    await settled;
    expect(hooks.onThreadTurn).toHaveBeenCalledWith(thread, { prompt: "Keep working", reply: "Parent done" });
    expect(hooks.onThreadTurn).toHaveBeenCalledOnce();
    expect(hooks.notify).toHaveBeenCalledExactlyOnceWith({ kind: "finished", threadId: thread.id, taskId: null, title: "Parent", body: "Parent done" });
    expect(checkpoints.listForThread(db, thread.id)).toHaveLength(1);
    expect(service.threadActivity(thread.id)).toBe("idle");
  });

  it("waits for a lead checkpoint and returns its durable identifier", async () => {
    const thread = threads.insert(db, { projectId: project.id, title: "Lead", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    const run = await service.start({ scope: { task: null, thread }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Coordinate", resume: false });
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "one", status: "success", durationMs: 1 });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
    expect(hooks.onTurnSettled).toHaveBeenCalledWith(expect.anything(), expect.anything(), project, {
      status: "success",
      snapshotId: checkpoints.listForThread(db, thread.id)[0]!.id,
      error: null,
      turnStatus: "success",
      captureError: null,
    });
    // The checkpoint's tree is pinned, so git gc keeps it, and it knows which folder it came from.
    const [saved] = checkpoints.listForThread(db, thread.id);
    expect(saved!.root).toBe(await realpath(project.rootPath));
    expect((await git(project.rootPath, ["for-each-ref", "--format=%(objectname)", checkpointRefs(thread.id)])).stdout.trim()).toBe(saved!.treeSha);
    expect(service.threadActivity(thread.id)).toBe("idle");
  });

  it("retains live state on close timeout and denies both pending and late approvals", async () => {
    automaticExit = false;
    const run = await service.start(taskInput({ agent: "claude" }));
    const pending = service.requestApproval(run.id, "permission", "Bash", {});
    await expect(service.closeAndWait(run.id, 10)).rejects.toThrow("still closing");
    await expect(pending).resolves.toEqual({ decision: "deny" });
    await expect(service.requestApproval(run.id, "late", "Bash", {})).resolves.toEqual({ decision: "deny" });
    expect(service.pending()).toEqual([]);
    expect(service.isLive(run.id)).toBe(true);
    scripted.get(run.id)!.finish();
    await service.closeAndWait(run.id);
    expect(service.isLive(run.id)).toBe(false);
    expect(runs.get(db, run.id)?.state).toBe("cancelled");
    expect(hooks.onTurnSettled).toHaveBeenCalledWith(expect.anything(), expect.anything(), project, { status: "cancelled", snapshotId: null, error: null });
  });

  it("accepts a close-signal race only after the process and finalization barriers finish", async () => {
    automaticExit = false;
    const run = await service.start(taskInput({ agent: "claude" }));
    const session = scripted.get(run.id)!;
    vi.spyOn(session.handle, "close").mockImplementationOnce(() => {
      setTimeout(() => session.finish(), 5);
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "completed", status: "success", durationMs: 1 });
    await expect(service.closeAndWait(run.id)).resolves.toBeUndefined();
    expect(service.isLive(run.id)).toBe(false);
    expect(runs.get(db, run.id)).toMatchObject({ state: "success", endedAt: expect.any(Number) });
    expect(hooks.onRunFinished).toHaveBeenCalledOnce();
    await writers.withLease(root, "next writer", async () => {});
  });

  it("retains a denied live writer and reports the signal error when closure cannot be proven", async () => {
    automaticExit = false;
    const run = await service.start(taskInput({ agent: "claude" }));
    const session = scripted.get(run.id)!;
    vi.spyOn(session.handle, "close").mockImplementationOnce(() => {
      throw new Error("kill EPERM");
    });
    await expect(service.closeAndWait(run.id, 10)).rejects.toThrow(/kill EPERM.*still closing/);
    expect(service.isLive(run.id)).toBe(true);
    await expect(writers.acquire(root, "conflicting writer")).rejects.toThrow(/in use/);
    session.finish();
    await service.closeAndWait(run.id);
    await writers.withLease(root, "next writer", async () => {});
  });

  it("reports failed capture to the coordinator without claiming a saved result", async () => {
    const missing = { ...project, rootPath: path.join(root, "missing-workspace") };
    const run = await service.start(taskInput({ project: missing }));
    emit(run.id, { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "one", status: "success", durationMs: 1 });
    await service.closeAndWait(run.id);
    // The provider's own turn succeeded; only the capture failed, and the outcome says so separately so a conversation turn can keep its reply.
    expect(hooks.onTurnSettled).toHaveBeenCalledWith(expect.anything(), expect.anything(), missing, {
      status: "error",
      snapshotId: null,
      error: expect.stringContaining("Snapshot failed"),
      turnStatus: "success",
      captureError: expect.stringContaining("Snapshot failed"),
    });
    expect(hooks.onRunFinished).toHaveBeenCalledOnce();
  });
});

describe("background work", () => {
  function conversation() {
    const thread = threads.insert(db, { projectId: project.id, title: "Background", agent: "claude", model: "fixture", mode: "act", permissionMode: "trusted" });
    const input: StartRunInput = {
      scope: { task: null, thread },
      project,
      agent: "claude",
      model: "fixture",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Trace it in the background",
      resume: false,
    };
    return { thread, input };
  }
  const background = (runId: string, running: number) => emit(runId, { type: "background.updated", runId, ts: Date.now(), running });
  const turnCompleted = (runId: string, turnId: string) => emit(runId, { type: "turn.completed", runId, ts: Date.now(), turnId, status: "success", durationMs: 1 });

  it("keeps a thread working and its process open while background work outlives the turn", async () => {
    hooks.idleTimeoutMs = () => 100;
    hooks.onThreadIdle = vi.fn();
    const { thread, input } = conversation();
    const run = await service.start(input);
    background(run.id, 1);
    turnCompleted(run.id, "launch");
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
    expect(service.threadActivity(thread.id)).toBe("running");
    // Neither the idle clock, another writer nor an update may close the process under the work.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(writers.acquire(root, "review commit")).rejects.toThrow(/in use/);
    expect(service.prepareForUpdate()).toBe(false);
    expect(service.isLive(run.id)).toBe(true);

    // The agent comes back to report on the finished work, and its questions reach the user.
    emit(run.id, { type: "turn.started", runId: run.id, ts: Date.now(), turnId: "report" });
    background(run.id, 0);
    await vi.waitFor(() => expect(service.isBusy(run.id)).toBe(true));
    const question = service.requestUserInput(run.id, "next", {
      questions: [
        {
          id: "next",
          question: "Ship it?",
          options: [
            { label: "Yes", description: "Ship" },
            { label: "No", description: "Hold" },
          ],
        },
      ],
    });
    expect(service.threadActivity(thread.id)).toBe("waiting");
    turnCompleted(run.id, "report");
    await expect(question).resolves.toMatchObject({ status: "cancelled" });
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledTimes(2));
    expect(service.threadActivity(thread.id)).toBe("idle");
    expect(hooks.onThreadIdle).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(service.isLive(run.id)).toBe(false), { timeout: 3000 });
  });

  it("idles a thread whose background work ends with no turn to report on it", async () => {
    hooks.idleTimeoutMs = () => 100;
    hooks.onThreadIdle = vi.fn();
    const { thread, input } = conversation();
    const run = await service.start(input);
    background(run.id, 1);
    turnCompleted(run.id, "launch");
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
    background(run.id, 0);
    await vi.waitFor(() => expect(service.threadActivity(thread.id)).toBe("idle"));
    expect(hooks.onThreadIdle).toHaveBeenCalledWith(expect.objectContaining({ id: thread.id }));
    await vi.waitFor(() => expect(service.isLive(run.id)).toBe(false), { timeout: 3000 });
  });

  it("finishes a turn that leaves a command running, and keeps its process open until the command is stopped", async () => {
    hooks.idleTimeoutMs = () => 100;
    hooks.onThreadIdle = vi.fn();
    const { thread, input } = conversation();
    const run = await service.start(input);
    const server = { id: "b1", description: "Serve the preview" };
    emit(run.id, { type: "background.updated", runId: run.id, ts: Date.now(), running: 0, commands: [server] });
    turnCompleted(run.id, "launch");
    await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
    expect(service.threadActivity(thread.id)).toBe("idle");
    expect(service.threadBackgroundCommands(thread.id)).toEqual([server]);
    // Neither the idle clock, another writer nor an update may end the server.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(writers.acquire(root, "review commit")).rejects.toThrow(/in use/);
    expect(service.prepareForUpdate()).toBe(false);
    await expect(service.reserveAgentUpdate()).rejects.toThrow(/background commands/);
    expect(service.isLive(run.id)).toBe(true);

    await service.stopBackgroundCommand(thread.id, "ended");
    expect(stopTransport).not.toHaveBeenCalled();
    await service.stopBackgroundCommand(thread.id, "b1");
    expect(stopTransport).toHaveBeenCalledWith("b1");
    emit(run.id, { type: "background.updated", runId: run.id, ts: Date.now(), running: 0, commands: [] });
    await vi.waitFor(() => expect(service.threadBackgroundCommands(thread.id)).toEqual([]));
    await vi.waitFor(() => expect(service.isLive(run.id)).toBe(false), { timeout: 3000 });
    expect(hooks.onThreadIdle).not.toHaveBeenCalled();
  });
});
