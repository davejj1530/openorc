import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, settings, teamContexts, teamMoves, teamRestores, teamRuntime, threads } from "@openorc/db";
import * as gitTools from "@openorc/git";
const { commitAll, git } = gitTools;
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { buildTeamForkSeed } from "./services/team-context.js";

let core: OpenOrc;
let folder: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let rpcId = 0;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-git-routing-"));
  const root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Scheduled fixture\n");
  await commitAll(root, "Fixture baseline");
  const bare = path.join(folder, "remote.git");
  await git(root, ["init", "--bare", "-q", bare]);
  await git(root, ["remote", "add", "origin", bare]);
  await git(root, ["push", "-u", "origin", "main"]);
  pushed = [];
  turns = new Map();
  const start = (spec: RunSpec) => {
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
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(start);
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(start);
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => [
    { id: `fixture-${agent}`, label: "Scripted provider", agent: agent ?? "codex", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high", fastMode: { supported: false } },
  ]);
  vi.spyOn(gitTools, "hasGh").mockResolvedValue(true);
  vi.spyOn(gitTools, "createPr").mockResolvedValue("https://example.invalid/pull/1");
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function team() {
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Git lifecycle team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture-codex", effort: "high", fastMode: false } }],
    },
  });
  const created = await call("threads.start", {
    projectId: project.id,
    prompt: "Prepare integrated output",
    mode: "act",
    permissionMode: "trusted",
    executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
  });
  await core.teams.drain();
  return created.thread;
}
async function finish(threadId: string) {
  const record = teamRuntime.activeForThread(core.db, threadId)!;
  const attempt = core.teams.status(record.id).attempts.at(-1)!;
  const turn = turns.get(attempt.runId!)!;
  await writeFile(path.join(turn.spec.cwd, "team-output.txt"), "Integrated lead output\n");
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text: "Team work completed", ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now() });
  await vi.waitFor(() => expect(core.teams.status(record.id).state).toBe("completed"), { timeout: 10000 });
  await core.teams.drain();
}
async function published(threadId: string) {
  await finish(threadId);
  const commit = await call("review.commitThread", { threadId, message: "Integrated team changes" });
  await call("review.pushThread", { threadId });
  return commit;
}

describe("team Git admission through the public runtime", () => {
  it("moves a team into the real local checkout and back, preserving unrelated edits and running the lead at the selected location", async () => {
    const thread = await team();
    await finish(thread.id);
    const firstRunId = [...turns.keys()][0]!;
    const original = threads.get(core.db, thread.id)!;
    await writeFile(path.join(project.rootPath, "README.md"), "Staged local edit\n");
    await git(project.rootPath, ["add", "README.md"]);
    await writeFile(path.join(project.rootPath, "README.md"), "Unstaged local edit\n");
    const index = await readFile(path.join(project.rootPath, ".git", "index"));
    const head = (await git(project.rootPath, ["rev-parse", "HEAD"])).stdout.trim();
    const local = await call("threads.moveWorkspace", { id: thread.id, to: "current", requestKey: "local" });
    expect(local).toMatchObject({ id: thread.id, workspaceMode: "current", worktreePath: null });
    expect(await readFile(path.join(project.rootPath, "team-output.txt"), "utf8")).toBe("Integrated lead output\n");
    expect(await readFile(path.join(project.rootPath, "README.md"), "utf8")).toBe("Unstaged local edit\n");
    expect(await readFile(path.join(project.rootPath, ".git", "index"))).toEqual(index);
    expect(await readFile(path.join(original.worktreePath!, "team-output.txt"), "utf8")).toBe("Integrated lead output\n");
    await call("orchestration.send", { threadId: thread.id, requestKey: "local-turn", text: "Work in the selected local checkout" });
    await core.teams.drain();
    const active = teamRuntime.activeForThread(core.db, thread.id)!;
    const localTurn = turns.get(active.attempts.at(-1)!.runId!)!;
    expect(await realpath(localTurn.spec.cwd)).toBe(await realpath(project.rootPath));
    expect(active.attempts.at(-1)!.contextSeed).toContain('"movedWorkspace"');
    await writeFile(path.join(localTurn.spec.cwd, "local-team.txt"), "Local lead output\n");
    await finish(thread.id);
    const isolated = await call("threads.moveWorkspace", { id: thread.id, to: "worktree", requestKey: "isolated" });
    if ("rejected" in isolated) throw new Error(isolated.rejected);
    expect(isolated.workspaceMode).toBe("worktree");
    expect(isolated.worktreePath).not.toBe(original.worktreePath);
    for (const file of ["team-output.txt", "local-team.txt"]) {
      expect(await readFile(path.join(isolated.worktreePath!, file), "utf8")).toContain("output");
      await expect(readFile(path.join(project.rootPath, file))).rejects.toThrow(/ENOENT/);
    }
    expect(await readFile(path.join(project.rootPath, "README.md"), "utf8")).toBe("Unstaged local edit\n");
    expect(await readFile(path.join(project.rootPath, ".git", "index"))).toEqual(index);
    expect((await git(project.rootPath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    const runtime = (await call("orchestration.runtime", { threadId: thread.id }))!;
    expect(runtime.workspaceMoves).toHaveLength(2);
    expect(runtime.context?.checkpoints).toEqual([]);
    expect(teamMoves.forThread(core.db, thread.id)).toHaveLength(2);
    expect(JSON.parse(buildTeamForkSeed(core.db, thread.id, firstRunId).seed).movedWorkspace).toBeUndefined();
    expect(JSON.parse(buildTeamForkSeed(core.db, thread.id, localTurn.spec.runId).seed).movedWorkspace).toMatchObject({ to: "current" });
    await call("review.commitThread", { threadId: thread.id, message: "Publish moved output" });
    expect((await git(project.rootPath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(threads.get(core.db, thread.id)?.branch).toBe(isolated.branch);
    expect(await call("threads.moveWorkspace", { id: thread.id, to: "current", requestKey: "local" })).toMatchObject({ worktreePath: isolated.worktreePath });
  });

  it("restores a local team into an independent workspace and publishes its restored files without rewinding the checkout", async () => {
    const thread = await team();
    await finish(thread.id);
    const selected = (await call("threads.checkpoints", { id: thread.id }))[0]!;
    const moved = await call("threads.moveWorkspace", { id: thread.id, to: "current", requestKey: "before-restore" });
    if ("rejected" in moved) throw new Error(moved.rejected);
    await writeFile(path.join(project.rootPath, "team-output.txt"), "Later local output\n");
    const localCommit = await call("review.commitThread", { threadId: thread.id, message: "Commit local output" });
    await writeFile(path.join(project.rootPath, "README.md"), "Uncommitted local edit\n");
    const index = await readFile(path.join(project.rootPath, ".git", "index"));
    const restored = await call("threads.restore", { id: thread.id, checkpointId: selected.id, requestKey: "from-local" });
    if (restored && "rejected" in restored) throw new Error(restored.rejected);
    const current = threads.get(core.db, thread.id)!;
    const receipt = teamRestores.latestForThread(core.db, thread.id)!;
    expect(current).toMatchObject({ workspaceMode: "worktree", branch: `openorc/team-${thread.id}-restore-${receipt.id}` });
    expect(await readFile(path.join(current.worktreePath!, "team-output.txt"), "utf8")).toBe("Integrated lead output\n");
    expect((await git(current.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localCommit.sha);
    const commit = await call("review.commitThread", { threadId: thread.id, message: "Publish restored files" });
    expect((await git(current.worktreePath!, ["rev-parse", `${commit.sha}^`])).stdout.trim()).toBe(localCommit.sha);
    expect((await git(project.rootPath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localCommit.sha);
    expect(await readFile(path.join(project.rootPath, "team-output.txt"), "utf8")).toBe("Later local output\n");
    expect(await readFile(path.join(project.rootPath, "README.md"), "utf8")).toBe("Uncommitted local edit\n");
    expect(await readFile(path.join(project.rootPath, ".git", "index"))).toEqual(index);
  });

  it("restores files without rewinding publication history, exposes public recovery, and starts fresh lead context on demand", async () => {
    const thread = await team();
    await expect(call("threads.restore", { id: thread.id, checkpointId: "any", requestKey: "active" })).resolves.toMatchObject({ rejected: expect.stringMatching(/finish|team|work|turn/i) });
    expect(teamRestores.forThread(core.db, thread.id)).toEqual([]);
    await finish(thread.id);
    const selected = (await call("threads.checkpoints", { id: thread.id }))[0]!;
    const original = threads.get(core.db, thread.id)!;
    await writeFile(path.join(original.worktreePath!, "team-output.txt"), "Later committed version\n");
    const commit = await call("review.commitThread", { threadId: thread.id, message: "Publish later files" });
    await writeFile(path.join(original.worktreePath!, "team-output.txt"), "Uncommitted later files\n");
    const input = { id: thread.id, checkpointId: selected.id, requestKey: "restore-routing" };
    await call("threads.restore", input);
    const current = threads.get(core.db, thread.id)!;
    expect(current.branch).toBe(`openorc/team-${thread.id}`);
    expect(await readFile(path.join(original.worktreePath!, "team-output.txt"), "utf8")).toBe("Uncommitted later files\n");
    expect(await readFile(path.join(current.worktreePath!, "team-output.txt"), "utf8")).toBe("Integrated lead output\n");
    expect((await git(current.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(commit.sha);
    const runtime = (await call("orchestration.runtime", { threadId: thread.id }))!;
    expect(runtime.actions?.commit.allowed).toBe(true);
    expect(runtime.workspaceRestores).toHaveLength(1);
    expect(runtime.context?.checkpoints).toEqual([]);
    expect(JSON.stringify(runtime)).not.toContain('"seed"');
    expect(turns.size).toBe(1);
    const restoredContext = teamContexts.latest(core.db, { instanceId: runtime.instance.id, executionId: null, actorId: "lead" })!;
    const revert = await call("review.commitThread", { threadId: thread.id, message: "Explicitly restore checkpoint files" });
    expect((await git(current.worktreePath!, ["rev-parse", `${revert.sha}^`])).stdout.trim()).toBe(commit.sha);
    await call("orchestration.send", { threadId: thread.id, requestKey: "after-restore", text: "Continue from the restored checkpoint" });
    await core.teams.drain();
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const attempt = execution.attempts.at(-1)!;
    expect(attempt.contextCheckpointId).toBe(restoredContext.id);
    expect(attempt.contextSessionId).toBeUndefined();
    expect(attempt.contextSeed).toContain('"restoredWorkspace"');
    expect(attempt.contextSeed).toContain("Prepare integrated output");
    expect(attempt.contextSeed).toContain("Never replay historical assignments");
    expect(turns.size).toBe(2);
    const advancedPath = threads.get(core.db, thread.id)!.worktreePath;
    // A lost acknowledgement from the earlier restore remains a read-only replay,
    // including while a newer lead is working in its independent workspace.
    await call("threads.restore", input);
    expect(threads.get(core.db, thread.id)!.worktreePath).toBe(advancedPath);
    expect(teamContexts.latest(core.db, { instanceId: runtime.instance.id, executionId: null, actorId: "lead" })!.id).toBe(restoredContext.id);
    expect(teamRestores.forThread(core.db, thread.id)).toHaveLength(1);
  });

  it("blocks active work, then publishes only the integrated lead and preserves its branch into the next execution", async () => {
    const thread = await team();
    expect(core.review.teamActionAvailability(thread.id).allowed).toBe(false);
    await expect(call("review.commitThread", { threadId: thread.id, message: "Too soon" })).rejects.toThrow(/team|work|finish/i);
    const commit = await published(thread.id);
    expect(core.review.teamActionAvailability(thread.id)).toEqual({ allowed: true, reason: null });
    const branch = `openorc/team-${thread.id}`;
    expect((await git(project.rootPath, ["ls-remote", "origin", `refs/heads/${branch}`])).stdout.trim().split(/\s/)[0]).toBe(commit.sha);
    const priorPath = threads.get(core.db, thread.id)!.worktreePath!;
    await call("orchestration.send", { threadId: thread.id, requestKey: "followup", text: "Continue the implementation" });
    await core.teams.drain();
    expect(threads.get(core.db, thread.id)).toMatchObject({ branch });
    // The conversation keeps one lead workspace across executions.
    expect(threads.get(core.db, thread.id)?.worktreePath).toBe(priorPath);
    expect((await git(priorPath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(commit.sha);
  });

  it("reports what a push would publish from the team's detached lead workspace", async () => {
    const thread = await team();
    await finish(thread.id);
    const { sha } = await call("review.commitThread", { threadId: thread.id, message: "Integrated team changes" });
    const branch = `openorc/team-${thread.id}`;
    expect(await call("git.threadPushState", { threadId: thread.id })).toEqual({ branch, blocked: null, published: false, unpushedCount: 1, unpushed: [sha] });
    await call("review.pushThread", { threadId: thread.id });
    expect(await call("git.threadPushState", { threadId: thread.id })).toEqual({ branch, blocked: null, published: true, unpushedCount: 0, unpushed: [] });
  });

  it("rejects new execution admission while PR readiness awaits, then allows the unchanged request after release", async () => {
    const thread = await team();
    await published(thread.id);
    const held = deferred();
    vi.mocked(gitTools.hasGh).mockImplementationOnce(async () => {
      await held.promise;
      return true;
    });
    const pending = call("review.createThreadPr", { threadId: thread.id, title: "Integrated PR", body: "Explicit user publication", base: "main" });
    await vi.waitFor(() => expect(gitTools.hasGh).toHaveBeenCalled());
    expect(core.review.teamActionAvailability(thread.id)).toMatchObject({ allowed: false, reason: expect.stringContaining("operation") });
    const direction = { threadId: thread.id, requestKey: "while-publishing", text: "Next execution" };
    await expect(call("orchestration.send", direction)).rejects.toThrow(/operation/);
    expect(teamRuntime.activeForThread(core.db, thread.id)).toBeNull();
    expect(turns.size).toBe(1);
    held.resolve();
    expect(await pending).toEqual({ url: "https://example.invalid/pull/1" });
    await call("orchestration.send", direction);
    await core.teams.drain();
    expect(turns.size).toBe(2);
    expect(gitTools.createPr).toHaveBeenCalledTimes(1);
  });
});
