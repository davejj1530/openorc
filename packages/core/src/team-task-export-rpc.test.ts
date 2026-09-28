import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, settings, tasks, teamRuntime, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let folder: string;
let root: string;
let bare: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let rpcId = 0;
const member = (key: string, managerKey: string | null) => ({
  key,
  name: key,
  managerKey,
  responsibility: `Do ${key} work`,
  settings: { agent: "codex" as const, model: "fixture-codex", effort: "high", fastMode: false },
});

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-task-export-"));
  root = path.join(folder, "repository");
  bare = path.join(folder, "remote.git");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Export fixture\n");
  await commitAll(root, "Fixture baseline");
  await git(root, ["init", "--bare", "-q", bare]);
  await git(root, ["remote", "add", "origin", bare]);
  await git(root, ["push", "-q", "-u", "origin", "main"]);
  // Uncommitted lead input that workers inherit and therefore export.
  await writeFile(path.join(root, "inherited.txt"), "uncommitted lead input\n");
  pushed = [];
  turns = new Map();
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let close!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      close = resolve;
    });
    let closed = false;
    const handle = new RunHandle(spec.runId, {
      done,
      send: async () => {},
      interrupt() {},
      close() {
        if (closed) return;
        closed = true;
        handle.emit("exit", 0);
        close(0);
      },
    });
    turns.set(spec.runId, { spec, handle });
    return handle;
  });
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: bare, settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => [
    { id: `fixture-${agent}`, label: "Scripted provider", agent: agent ?? "codex", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } },
  ]);
  await call("app.settings.set", { experimentalTeamExecution: true });
});
afterEach(async () => {
  if (core) await core.close();
  vi.restoreAllMocks();
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++rpcId;
  await core.handle({ type: "rpc", id, method, params });
  const response = pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);
  if (!response || (response.type !== "rpc.result" && response.type !== "rpc.error")) throw new Error("Missing RPC response");
  if (response.type === "rpc.error") throw new Error(response.message);
  return response.result as RpcResults[M];
}
async function liveRun(executionId: string, actorId: string) {
  await vi.waitFor(() => expect(core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")?.runId).toBeTruthy(), { timeout: 15000 });
  const runId = core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")!.runId!;
  return { runId, ...turns.get(runId)! };
}
function endTurn(turn: { spec: RunSpec; handle: RunHandle }, text: string) {
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now() });
}

describe("task-specific Git publication and patch export through the public boundary", () => {
  it("publishes a finished worker assignment on its own branch, exports a lossless patch, and leaves the team branch alone", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Export team",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", null), member("worker", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Delegate one change",
    });
    await core.teams.drain();
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const leadTurn = await liveRun(execution.id, "lead");
    const worker = core.teams.dispatch(leadTurn.runId, { memberKey: "worker", requestKey: "w", title: "Worker change", spec: "Add a file", dependencies: [], attachments: [] });
    core.teams.wait(leadTurn.runId, { assignmentIds: [worker.id] });
    endTurn(leadTurn, "Delegated");
    const workerTurn = await liveRun(execution.id, worker.id);
    const taskId = worker.taskId!;
    // While the worker is running its task cannot be published.
    let view = (await call("orchestration.taskState", { taskId }))!;
    expect(view.export).toMatchObject({ allowed: false, reason: expect.stringMatching(/current turn/), branch: `openorc/team-task-${taskId}` });
    await expect(call("review.commit", { taskId, message: "Too early" })).rejects.toThrow(/current turn/);
    await writeFile(path.join(workerTurn.spec.cwd, "worker.txt"), "worker output\n");
    core.teams.complete(workerTurn.runId, { result: "Added worker.txt" });
    endTurn(workerTurn, "Done");
    await vi.waitFor(() => expect(core.teams.status(execution.id).actors.find((actor) => actor.id === worker.id)?.state).toBe("completed"), { timeout: 15000 });
    // The lead resumes and completes so the whole team is idle for the rest of the test.
    const resumed = await liveRun(execution.id, "lead");
    core.teams.complete(resumed.runId, { result: "Integrated" });
    endTurn(resumed, "Integrated");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });

    view = (await call("orchestration.taskState", { taskId }))!;
    expect(view.export).toEqual({ allowed: true, reason: null, branch: `openorc/team-task-${taskId}` });
    const task = tasks.get(core.db, taskId)!;
    expect(task.branch).toBeNull();
    const exported = await call("review.exportPatch", { taskId });
    const patch = await readFile(exported.path, "utf8");
    expect(patch).toContain("+worker output");
    expect(patch).toContain("+uncommitted lead input");
    expect(exported.files).toBe(2);
    expect(exported.path.startsWith(path.join(folder, "data", "exports"))).toBe(true);
    const committed = await call("review.commit", { taskId, message: "Publish the worker assignment" });
    const branch = `openorc/team-task-${taskId}`;
    expect((await git(root, ["rev-parse", `refs/heads/${branch}`])).stdout.trim()).toBe(committed.sha);
    expect(tasks.get(core.db, taskId)?.branch).toBe(branch);
    expect(threads.get(core.db, thread.id)?.branch).toBeNull();
    expect((await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/openorc/team-${thread.id}`], { okCodes: [0, 1] })).code).toBe(1);
    expect((await git(task.worktreePath!, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).code).toBe(1);
    expect((await git(root, ["show", `${committed.sha}:worker.txt`])).stdout).toBe("worker output\n");
    expect(await call("review.push", { taskId })).toEqual({ remote: "origin", branch });
    expect((await git(root, ["ls-remote", "origin", `refs/heads/${branch}`])).stdout.trim().split(/\s/)[0]).toBe(committed.sha);
    expect(await readFile(path.join(root, "inherited.txt"), "utf8")).toBe("uncommitted lead input\n");
    expect((await git(root, ["status", "--porcelain"])).stdout).toContain("inherited.txt");
    expect(await call("review.diff", { taskId })).toMatchObject({ baseSha: task.baseSha });
  });

  it("keeps ordinary solo task publication and export unchanged", async () => {
    const task = await call("tasks.create", { projectId: project.id, title: "Solo export", spec: "Plain task", useWorktree: false });
    await writeFile(path.join(root, "solo.txt"), "solo output\n");
    const exported = await call("review.exportPatch", { taskId: task.id });
    const patch = await readFile(exported.path, "utf8");
    expect(patch).toContain("+solo output");
    expect(await call("orchestration.taskState", { taskId: task.id })).toBeNull();
    expect((await git(root, ["for-each-ref", "refs/openorc/exports/"])).stdout.trim()).toBe("");
  });
});
