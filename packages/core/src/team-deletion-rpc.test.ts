import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { orchestration, projects, settings, tasks, teamContexts, teamDeletedThreads, teamDeletions, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { buildTeamContextSeed } from "./services/team-context.js";

let core: OpenOrc;
let folder: string;
let root: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let rpcId = 0;
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-deletion-rpc-"));
  root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Deletion fixture\n");
  await commitAll(root, "Fixture baseline");
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
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => [
    { id: `fixture-${agent}`, label: "Scripted provider", agent: agent ?? "codex", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } },
  ]);
  await call("app.settings.set", { experimentalTeamExecution: true, notifications: true });
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
async function startTeam(prompt: string) {
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Deletion team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture-codex", effort: "high", fastMode: false } }],
    },
  });
  const { thread } = await call("threads.start", { projectId: project.id, executionTarget: { kind: "team", teamRevisionId: saved.revision.id }, mode: "act", permissionMode: "trusted", prompt });
  await core.teams.drain();
  return thread;
}
async function finish(threadId: string, text: string) {
  const record = teamRuntime.activeForThread(core.db, threadId)!;
  await vi.waitFor(() => expect(core.teams.status(record.id).attempts.at(-1)?.runId).toBeTruthy(), { timeout: 10000 });
  const turn = turns.get(core.teams.status(record.id).attempts.at(-1)!.runId!)!;
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now() });
  await vi.waitFor(() => expect(core.teams.status(record.id).state).toBe("completed"), { timeout: 10000 });
  await core.teams.drain();
  return record;
}
const leadWorkspace = (executionId: string) => teamWorkspaces.get(core.db, executionId, "lead")!.path;

describe("team conversation deletion through the public boundary", () => {
  it("hides a deleted owner behind its saved task, runs Start through it, and fences every generic control", async () => {
    const thread = await startTeam("Build the feature end to end");
    const first = await finish(thread.id, "Feature built");
    const workspace = leadWorkspace(first.id);
    const task = await call("tasks.create", { projectId: project.id, threadId: thread.id, title: "Follow-up polish", spec: "Polish the feature", useWorktree: true });
    expect((await call("orchestration.taskState", { taskId: task.id }))?.ownerDeletedAt).toBeNull();
    expect((await call("orchestration.runtime", { threadId: thread.id }))?.actions?.delete).toEqual({ allowed: true, reason: null });
    await expect(call("threads.delete", { id: thread.id })).rejects.toThrow(/request key/);

    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-once" })).toBeNull();
    const marker = teamDeletedThreads.get(core.db, thread.id)!;
    expect(marker).toMatchObject({ threadId: thread.id, instanceId: first.instanceId });
    expect(teamDeletions.find(core.db, thread.id, "delete-once")).toMatchObject({ state: "applied", retainedTaskIds: [task.id], entries: [], appliedContextId: marker.contextCheckpointId });
    expect(await exists(workspace)).toBe(true);
    expect(threads.get(core.db, thread.id)).not.toBeNull();
    // The saved task keeps the conversation's history, room included.
    const roomEvents = () => core.db.stmt("SELECT COUNT(*) AS n FROM team_room_events WHERE instance_id=?").get(first.instanceId) as { n: number };
    expect(roomEvents().n).toBeGreaterThan(0);
    expect(await call("threads.get", { id: thread.id })).toBeNull();
    expect((await call("threads.list", { projectId: project.id, filter: "all" })).map((item) => item.id)).not.toContain(thread.id);
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-once" })).toBeNull();
    expect(await call("orchestration.runtime", { threadId: thread.id })).toBeNull();
    for (const attempt of [
      () => call("threads.fork", { id: thread.id, requestKey: "fork-after-delete" }),
      () => call("threads.restore", { id: thread.id, checkpointId: "any", requestKey: "restore-after-delete" }),
      () => call("threads.moveWorkspace", { id: thread.id, to: "current", requestKey: "move-after-delete" }),
      () => call("review.threadDiff", { threadId: thread.id }),
      () => call("runs.listForThread", { threadId: thread.id }),
      () => call("threads.send", { id: thread.id, text: "hello" }),
      () => call("orchestration.send", { threadId: thread.id, text: "Continue", requestKey: "send-no-task" }),
      () => call("orchestration.send", { threadId: thread.id, text: "Continue", requestKey: "send-idle", taskId: task.id }),
      () => call("threads.update", { id: thread.id, patch: { archived: true } }),
      () => call("threads.update", { id: thread.id, taskId: task.id, patch: { archived: true } }),
      () => call("threads.update", { id: thread.id, taskId: task.id, patch: { title: "Renamed" } }),
    ])
      await expect(attempt()).rejects.toThrow(/deleted|saved task/);
    // Historical reads for the retained activity keep working through the task's scope.
    expect((await call("files.read", { scope: { kind: "thread", id: thread.id }, path: "README.md" })).content).toContain("Deletion fixture");
    expect((await call("threads.update", { id: thread.id, taskId: task.id, patch: { mode: "plan" } })).mode).toBe("plan");
    expect((await call("threads.update", { id: thread.id, taskId: task.id, patch: { mode: "act" } })).mode).toBe("act");

    const state = (await call("orchestration.taskState", { taskId: task.id }))!;
    expect(state.ownerDeletedAt).toBe(marker.deletedAt);
    expect(state.start.allowed).toBe(true);
    const retained = (await call("orchestration.taskRuntime", { taskId: task.id }))!;
    expect(retained).toMatchObject({ thread: { id: thread.id, archivedAt: null, pinnedAt: null }, deletedAt: marker.deletedAt });
    expect(retained.runtime.executions.map((item) => item.id)).toEqual([first.id]);
    expect(retained.runtime.context?.checkpoints).toEqual([]);
    expect(retained.runtime.actions?.fork?.allowed).toBe(false);

    const started = await call("orchestration.tasks.start", { taskId: task.id, requestKey: "start-after-delete" });
    await core.teams.drain();
    const active = teamRuntime.activeForThread(core.db, thread.id)!;
    expect(active.admission).toMatchObject({ scope: "thread", requestKey: `task:${started.admissionId}` });
    await vi.waitFor(() => expect(core.teams.status(active.id).attempts[0]?.runId).toBeTruthy(), { timeout: 10000 });
    const attempt = core.teams.status(active.id).attempts[0]!;
    expect(attempt.contextCheckpointId).toBe(marker.contextCheckpointId);
    expect(attempt.contextSeed).toContain("deleted this team conversation");
    expect(attempt.contextSeed).not.toContain("Build the feature end to end");
    expect(attempt.contextSeed).toContain(task.id);
    expect(await realpath(turns.get(attempt.runId!)!.spec.cwd)).toBe(await realpath(leadWorkspace(active.id)));
    const rebuilt = JSON.parse(buildTeamContextSeed(core.db, { instanceId: first.instanceId, executionId: null, actorId: "lead" })) as {
      canonical: { executionId: string }[];
      deletedConversation: { tasks: { taskId: string }[] };
    };
    expect(rebuilt.canonical.map((item) => item.executionId)).toEqual([active.id]);
    expect(rebuilt.deletedConversation.tasks.map((item) => item.taskId)).toEqual([task.id]);

    await expect(call("orchestration.stop", { threadId: thread.id, executionId: active.id })).rejects.toThrow(/deleted/);
    await call("orchestration.send", { threadId: thread.id, text: "Keep the API stable", requestKey: "steer-retained", taskId: task.id });
    const direction = core.teams.status(active.id).messages.find((message) => message.body === "Keep the API stable")!;
    expect(direction.state).toBe("pending");
    await expect(call("orchestration.cancelDirection", { threadId: thread.id, executionId: active.id, messageId: direction.id })).rejects.toThrow(/deleted/);
    await call("orchestration.cancelDirection", { threadId: thread.id, executionId: active.id, messageId: direction.id, taskId: task.id });
    expect(core.teams.status(active.id).messages.find((message) => message.id === direction.id)?.state).toBe("cancelled");
    // The single-member lead is the assignee; its accepted request completes through the task tool before the turn ends.
    core.teamTasks.completeTask(attempt.runId!, { taskId: task.id, admissionId: started.admissionId, result: "Polished the feature" });
    await finish(thread.id, "Follow-up polished");
    expect((await call("orchestration.taskState", { taskId: task.id }))!.admissions.map((item) => item.state)).toEqual(["completed"]);
    const finished = pushed.find((message) => message.type === "notify" && message.executionId === active.id && message.kind === "finished");
    expect(finished).toMatchObject({ threadId: null, taskId: task.id });
    expect((await call("orchestration.taskRuntime", { taskId: task.id }))!.runtime.executions.map((item) => item.id)).toEqual([first.id, active.id]);
    expect(await call("threads.get", { id: thread.id })).toBeNull();
    expect(teamContexts.listForInstance(core.db, first.instanceId).map((item) => item.requestKey)).toEqual([`delete:${teamDeletions.find(core.db, thread.id, "delete-once")!.id}`]);

    // Deleting the last saved task deletes the hidden owner for good, through the same receipt and journal.
    const latest = leadWorkspace(active.id);
    expect((await call("orchestration.taskState", { taskId: task.id }))!.deleteOwner).toEqual({ allowed: true, reason: null, taskIds: [task.id] });
    await expect(call("tasks.delete", { id: task.id })).rejects.toThrow(/deleted together/);
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-final" })).toBeNull();
    expect(teamDeletions.find(core.db, thread.id, "delete-final")).toMatchObject({ state: "applied", retainedTaskIds: [], deletedTaskIds: [task.id] });
    expect(threads.get(core.db, thread.id)).toBeNull();
    expect(tasks.get(core.db, task.id)).toBeNull();
    expect(roomEvents().n).toBe(0);
    expect(await call("orchestration.taskState", { taskId: task.id })).toBeNull();
    expect(await call("orchestration.taskRuntime", { taskId: task.id })).toBeNull();
    expect(await exists(workspace)).toBe(false);
    expect(await exists(latest)).toBe(false);
    expect((await git(root, ["worktree", "list", "--porcelain"])).stdout).not.toContain(workspace);
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-final" })).toBeNull();
    expect((await call("tasks.list", { projectId: project.id })).map((item) => item.id)).not.toContain(task.id);
  });

  it("removes only the owned worktree of a taskless conversation, keeps the checkout, and replays the receipt", async () => {
    const thread = await startTeam("Throwaway exploration");
    const execution = await finish(thread.id, "Explored");
    const workspace = leadWorkspace(execution.id);
    const other = await startTeam("Neighbour keeps its files");
    const neighbour = await finish(other.id, "Kept");
    await writeFile(path.join(root, "local.txt"), "Unrelated local work\n");
    expect((await git(root, ["worktree", "list", "--porcelain"])).stdout).toContain(workspace);
    const gitDir = (await git(workspace, ["rev-parse", "--absolute-git-dir"])).stdout.trim();

    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-taskless" })).toBeNull();
    expect(threads.get(core.db, thread.id)).toBeNull();
    expect(orchestration.getInstance(core.db, thread.id)).toBeNull();
    expect(await exists(workspace)).toBe(false);
    expect(await exists(gitDir)).toBe(false);
    expect(await exists(path.dirname(workspace))).toBe(false);
    expect((await git(root, ["worktree", "list", "--porcelain"])).stdout).not.toContain(workspace);
    expect(await readFile(path.join(root, "local.txt"), "utf8")).toBe("Unrelated local work\n");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Deletion fixture\n");
    expect(await exists(leadWorkspace(neighbour.id))).toBe(true);
    const receipt = teamDeletions.find(core.db, thread.id, "delete-taskless")!;
    expect(receipt).toMatchObject({ state: "applied", retainedTaskIds: [], appliedContextId: null, seed: null });
    expect(receipt.entries.map((entry) => entry.path)).toEqual([workspace]);
    expect(receipt.items.map((item) => item.state)).toEqual(["removed"]);
    expect(teamDeletedThreads.get(core.db, thread.id)).toBeNull();
    // A lost response replays without a thread, an instance or any path left to touch.
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-taskless" })).toBeNull();
    expect((await call("threads.list", { projectId: project.id, filter: "all" })).map((item) => item.id)).toEqual([other.id]);
    expect((await call("orchestration.runtime", { threadId: other.id }))?.executions).toHaveLength(1);
  });

  it("rejects deletion durably while the team is working and never touches files", async () => {
    const thread = await startTeam("Long running work");
    const record = teamRuntime.activeForThread(core.db, thread.id)!;
    await vi.waitFor(() => expect(core.teams.status(record.id).attempts[0]?.runId).toBeTruthy(), { timeout: 10000 });
    const workspace = leadWorkspace(record.id);
    const rejected = await call("threads.delete", { id: thread.id, requestKey: "delete-busy" });
    expect(rejected).toMatchObject({ rejected: expect.stringMatching(/unfinished execution/) });
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-busy" })).toEqual(rejected);
    expect(await exists(workspace)).toBe(true);
    expect(await call("threads.get", { id: thread.id })).not.toBeNull();
    expect(teamDeletions.rejection(core.db, thread.id, "delete-busy")).not.toBeNull();
    await finish(thread.id, "Done now");
    // The rejected key stays rejected; a fresh key deletes.
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-busy" })).toEqual(rejected);
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-later" })).toBeNull();
    expect(await exists(workspace)).toBe(false);
  });
});
