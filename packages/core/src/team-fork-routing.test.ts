import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { checkpoints, orchestration, projects, runs, settings, tasks, teamContexts, teamForks, teamOrigins, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git, teamTransfer } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec, type Thread } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { TeamForkService, type TeamForkHooks } from "./services/team-forks.js";
import { buildTeamContextSeed } from "./services/team-context.js";
import { TeamWorkspaceSnapshots } from "./services/team-workspace-snapshots.js";
import { inheritedProbe } from "./services/shell-environment.js";

let core: OpenOrc;
let folder: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let coreClosed: boolean;
let rpcId = 0;
beforeEach(async () => {
  coreClosed = false;
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-fork-routing-"));
  const root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Scheduled fixture\n");
  await commitAll(root, "Fixture baseline");
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
  // Keep disk persistence for restart tests, but use the synthetic provider paths.
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), shellProbe: inheritedProbe(), transport: { push: (message) => pushed.push(message) } });
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  stubReadiness();
  await call("app.settings.set", { experimentalTeamExecution: true });
});
afterEach(async () => {
  if (core && !coreClosed) await core.close();
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

function accepted(result: Thread | { rejected: string }): Thread {
  if ("rejected" in result) throw new Error(`Expected an accepted fork: ${result.rejected}`);
  return result;
}

function stubReadiness() {
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => [
    { id: `fixture-${agent}`, label: "Scripted provider", agent: agent ?? "codex", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high", fastMode: { supported: false } },
  ]);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function forkService(hooks: TeamForkHooks = {}) {
  return new TeamForkService(core.db, path.join(folder, "data"), core.teamOperations, core.workspaceWriters, () => {}, hooks);
}
async function team() {
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Fork team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture-codex", effort: "high", fastMode: false } },
        { key: "one", name: "Worker one", managerKey: "lead", responsibility: "Implement", settings: { agent: "claude", model: "fixture-claude", effort: "medium", fastMode: false } },
        { key: "two", name: "Worker two", managerKey: "lead", responsibility: "Review", settings: { agent: "claude", model: "fixture-claude", effort: "medium", fastMode: false } },
      ],
    },
  });
  const result = await call("threads.start", {
    projectId: project.id,
    prompt: "Original source requirement",
    mode: "act",
    permissionMode: "trusted",
    executionTarget: { kind: "team", teamRevisionId: saved.revision.id, initialLeadOverrides: { effort: "medium" } },
  });
  await core.teams.drain();
  return threads.get(core.db, result.thread.id)!;
}
function active(threadId: string) {
  const execution = teamRuntime.activeForThread(core.db, threadId)!;
  const attempt = execution.attempts.at(-1)!;
  return { execution, attempt, turn: turns.get(attempt.runId!)! };
}
async function finish(threadId: string, reply = "Public source reply") {
  const { execution, turn } = active(threadId);
  const { runId, agent, model } = turn.spec;
  turn.handle.emit("event", { type: "session.started", runId, agent, model: model ?? "fixture", externalSessionId: `session-${runId}`, ts: Date.now() });
  turn.handle.emit("event", { type: "thinking.delta", runId, messageId: `private-${runId}`, text: "Hidden source reasoning must not transfer", ts: Date.now() });
  turn.handle.emit("event", { type: "message.completed", runId, role: "assistant", messageId: `reply-${runId}`, text: reply, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId, turnId: `turn-${runId}`, status: "success", durationMs: 1, ts: Date.now() });
  await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 10000 });
  await core.teams.drain();
  return core.teams.status(execution.id).attempts.at(-1)!;
}
async function followup(threadId: string, text: string) {
  await call("orchestration.send", { threadId, text, requestKey: text });
  await core.teams.drain();
  return active(threadId);
}
async function indexBytes(root: string) {
  const file = (await git(root, ["rev-parse", "--git-path", "index"])).stdout.trim();
  return readFile(path.resolve(root, file));
}
async function reopen() {
  if (!coreClosed) await core.close();
  pushed = [];
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), shellProbe: inheritedProbe(), transport: { push: (message) => pushed.push(message) } });
  coreClosed = false;
  stubReadiness();
}
function childHasNoAuthority(child: Thread) {
  expect(runs.listForThread(core.db, child.id)).toHaveLength(0);
  expect(tasks.list(core.db, { threadId: child.id })).toHaveLength(0);
  expect(core.db.stmt("SELECT id FROM team_executions WHERE thread_id=?").all(child.id)).toHaveLength(0);
  expect(core.db.stmt("SELECT b.run_id FROM team_run_bindings b JOIN team_executions e ON e.id=b.execution_id WHERE e.thread_id=?").all(child.id)).toHaveLength(0);
}

describe("independent team forks", () => {
  it("cancels a failed fork without losing its files or allowing a delayed retry to apply", async () => {
    const source = await team();
    await finish(source.id);
    const service = forkService({
      fault: (point) => {
        if (point === "materialized") throw new Error("Interrupted fork");
      },
    });
    const input = { threadId: source.id, requestKey: "cancel-fork" };
    await expect(service.fork(input)).rejects.toThrow("Interrupted fork");
    const receipt = teamForks.find(core.db, source.id, input.requestKey)!;
    const kept = path.join(receipt.paths[0]!, "manual.txt");
    await writeFile(kept, "Keep recovery work");
    expect(await call("threads.cancelTeamOperation", { id: source.id, kind: "fork", requestKey: input.requestKey })).toEqual({ state: "cancelled" });
    await reopen();
    expect(await readFile(kept, "utf8")).toBe("Keep recovery work");
    expect(core.teamOperations.reason(source.id)).toBeNull();
    expect(await core.teamForks.fork(input)).toMatchObject({ rejected: expect.stringMatching(/cancelled/) });
    expect(threads.get(core.db, receipt.destinationThreadId)).toBeNull();
    expect(() => teamForks.appendPath(core.db, receipt.id, path.join(folder, "late"))).toThrow();
  });

  it("preserves exact files, inherited ignored paths, executable modes and source index without copying runtime authority", async () => {
    await writeFile(path.join(project.rootPath, "carry.txt"), "Inherited untracked input\n");
    const source = await team();
    await writeFile(path.join(source.worktreePath!, ".gitignore"), "carry.txt\n");
    await finish(source.id);
    await writeFile(path.join(source.worktreePath!, "README.md"), "Staged source version\n");
    await git(source.worktreePath!, ["add", "README.md"]);
    await writeFile(path.join(source.worktreePath!, "README.md"), "Unstaged source version\n");
    const binary = Buffer.alloc(1_200_007, 0x9a);
    binary[100] = 0;
    await writeFile(path.join(source.worktreePath!, "large.bin"), binary);
    await writeFile(path.join(source.worktreePath!, "odd \n file.txt"), "Odd path bytes\r\n");
    await writeFile(path.join(source.worktreePath!, "tool.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(source.worktreePath!, "tool.sh"), 0o755);
    await symlink("README.md", path.join(source.worktreePath!, "linked-readme"));
    const beforeIndex = await indexBytes(source.worktreePath!);
    const beforeHead = (await git(source.worktreePath!, ["rev-parse", "HEAD"])).stdout;
    const child = accepted(await core.teamForks.fork({ threadId: source.id, requestKey: "exact-files" }));
    expect(child.worktreePath).not.toBe(source.worktreePath);
    expect(await readFile(path.join(child.worktreePath!, "README.md"), "utf8")).toBe("Unstaged source version\n");
    expect(await readFile(path.join(child.worktreePath!, "carry.txt"), "utf8")).toBe("Inherited untracked input\n");
    expect(await readFile(path.join(child.worktreePath!, "large.bin"))).toEqual(binary);
    expect(await readFile(path.join(child.worktreePath!, "odd \n file.txt"), "utf8")).toBe("Odd path bytes\r\n");
    expect((await lstat(path.join(child.worktreePath!, "tool.sh"))).mode & 0o111).not.toBe(0);
    expect(await readlink(path.join(child.worktreePath!, "linked-readme"))).toBe("README.md");
    expect(await indexBytes(source.worktreePath!)).toEqual(beforeIndex);
    expect((await git(source.worktreePath!, ["rev-parse", "HEAD"])).stdout).toBe(beforeHead);
    const parentPin = orchestration.getInstance(core.db, source.id)!,
      pin = orchestration.getInstance(core.db, child.id)!;
    expect(pin.id).not.toBe(parentPin.id);
    expect(pin.teamRevisionId).toBe(parentPin.teamRevisionId);
    expect(pin.leadOverrides).toEqual(parentPin.leadOverrides);
    expect(pin.members.every((member) => !parentPin.members.some((other) => other.id === member.id))).toBe(true);
    childHasNoAuthority(child);
    expect(teamOrigins.get(core.db, pin.id)?.seed).toContain("Original source requirement");
    expect(teamOrigins.get(core.db, pin.id)?.seed).toContain("Public source reply");
    expect(teamOrigins.get(core.db, pin.id)?.seed).not.toContain("Hidden source reasoning");
    const next = await followup(child.id, "Continue independently");
    expect(next.turn.spec.resumeSessionId).toBeUndefined();
    expect(next.turn.spec.systemPromptAppendix).toContain("Original source requirement");
    expect(next.turn.spec.systemPromptAppendix).toContain("Public source reply");
    expect(next.turn.spec.systemPromptAppendix).not.toContain("Hidden source reasoning");
    const prepared = teamWorkspaces.get(core.db, next.execution.id, "lead")!;
    expect((await teamTransfer.listTree(next.turn.spec.cwd, prepared.preparedTree!)).some((entry) => entry.path === "carry.txt")).toBe(true);
    expect(await readFile(path.join(next.turn.spec.cwd, "carry.txt"), "utf8")).toBe("Inherited untracked input\n");
    expect(core.review.teamActionAvailability(child.id).allowed).toBe(false);
  });

  it("coalesces concurrent requests and replays a lost applied response after restart as the same child", async () => {
    const source = await team();
    await finish(source.id);
    const held = deferred();
    const service = forkService({
      fault: async (point) => {
        if (point === "retained") await held.promise;
        if (point === "applied") throw new Error("Simulated lost response after admission");
      },
    });
    const first = service.fork({ threadId: source.id, requestKey: "lost-response" });
    const same = service.fork({ threadId: source.id, requestKey: "lost-response" });
    expect(first).toBe(same);
    const rejected = expect(first).rejects.toThrow(/lost response/);
    held.resolve();
    await rejected;
    const receipt = teamForks.find(core.db, source.id, "lost-response")!;
    expect(receipt.state).toBe("applied");
    await reopen();
    const replay = accepted(await call("threads.fork", { id: source.id, requestKey: "lost-response" }));
    expect(replay.id).toBe(receipt.destinationThreadId);
    expect(threads.list(core.db, { projectId: project.id })).toHaveLength(2);
    expect(teamForks.find(core.db, source.id, "lost-response")?.paths).toHaveLength(1);
    childHasNoAuthority(replay);
    await expect(core.teamForks.fork({ threadId: source.id, upToRunId: "different-cutoff", requestKey: "lost-response" })).rejects.toThrow(/different work/);
  });

  it("preserves a failed materialization, blocks source admission, and retries into a new directory after restart", async () => {
    const source = await team();
    await finish(source.id);
    await writeFile(path.join(source.worktreePath!, "captured.txt"), "Frozen fork input\n");
    const faulty = forkService({
      fault: (point) => {
        if (point === "materialized") throw new Error("Interrupted after files arrived");
      },
    });
    await expect(faulty.fork({ threadId: source.id, requestKey: "retry-materialization" })).rejects.toThrow(/Interrupted/);
    const retained = teamForks.find(core.db, source.id, "retry-materialization")!;
    expect(retained.state).toBe("attention");
    const originalPath = retained.paths[0]!;
    await writeFile(path.join(originalPath, "user-recovery.txt"), "Preserve this candidate\n");
    await expect(call("orchestration.send", { threadId: source.id, requestKey: "blocked-by-fork", text: "Do not admit yet" })).rejects.toThrow(/fork|workspace operation/);
    await reopen();
    await expect(call("orchestration.send", { threadId: source.id, requestKey: "still-blocked", text: "Still blocked" })).rejects.toThrow(/fork|workspace operation/);
    const child = accepted(await core.teamForks.fork({ threadId: source.id, requestKey: "retry-materialization" }));
    expect(child.id).toBe(retained.destinationThreadId);
    expect(child.worktreePath).not.toBe(originalPath);
    expect(await readFile(path.join(originalPath, "user-recovery.txt"), "utf8")).toBe("Preserve this candidate\n");
    expect(await readFile(path.join(child.worktreePath!, "captured.txt"), "utf8")).toBe("Frozen fork input\n");
    expect(teamForks.find(core.db, source.id, "retry-materialization")?.paths).toHaveLength(2);
    expect(core.teamForks.availability(source.id)).toEqual({ allowed: true, reason: null });
  });

  it("uses the included attempt's checkpoint even when its run differs, excluding later context, files and commits", async () => {
    const source = await team();
    await writeFile(path.join(source.worktreePath!, "version.txt"), "At the selected turn\n");
    const first = await finish(source.id, "First public reply");
    await followup(source.id, "Included second instruction");
    const selected = await finish(source.id, "Selected second reply");
    expect(selected.snapshotId).toBe(first.snapshotId);
    expect(checkpoints.get(core.db, selected.snapshotId!)?.runId).toBe(first.runId);
    const later = await followup(source.id, "Later instruction must stay outside the fork");
    await writeFile(path.join(later.turn.spec.cwd, "version.txt"), "Later content\n");
    await writeFile(path.join(later.turn.spec.cwd, "later.txt"), "Not included\n");
    await finish(source.id, "Later private-to-parent public reply");
    const laterCommit = await core.review.commitThread(threads.get(core.db, source.id)!, project, "Later source commit");
    const child = accepted(await call("threads.fork", { id: source.id, upToRunId: selected.runId!, requestKey: "cutoff" }));
    expect(await readFile(path.join(child.worktreePath!, "version.txt"), "utf8")).toBe("At the selected turn\n");
    await expect(readFile(path.join(child.worktreePath!, "later.txt"))).rejects.toThrow(/ENOENT/);
    expect((await git(child.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).not.toBe(laterCommit.sha);
    const instance = orchestration.getInstance(core.db, child.id)!;
    const origin = teamOrigins.get(core.db, instance.id)!;
    expect(origin.sourceRunId).toBe(selected.runId);
    expect(origin.seed).toContain("Included second instruction");
    expect(origin.seed).toContain("Selected second reply");
    expect(origin.seed).not.toContain("Later instruction");
    expect(origin.seed).not.toContain("Later private-to-parent");
    expect(origin.seed).not.toContain("Hidden source reasoning");
  });

  it("rejects a legacy cutoff without exact capture proof before admitting a child", async () => {
    const source = await team();
    const selected = await finish(source.id);
    const binding = teamRuntime.binding(core.db, selected.runId!)!;
    const workspace = teamWorkspaces.get(core.db, binding.executionId, "lead")!;
    const prefix = `refs/openorc/teams/${workspace.id}/checkpoints/`;
    const refs = (await git(project.rootPath, ["for-each-ref", "--format=%(refname)", prefix])).stdout
      .trim()
      .split("\n")
      .filter((ref) => ref.startsWith(`${prefix}${selected.runId}-`));
    expect(refs.some((ref) => ref.endsWith("/tree"))).toBe(true);
    for (const ref of refs) await git(project.rootPath, ["update-ref", "-d", ref]);
    expect(checkpoints.get(core.db, selected.snapshotId!)).not.toBeNull();
    const request = { id: source.id, upToRunId: selected.runId!, requestKey: "legacy-cutoff" };
    const rejected = await call("threads.fork", request);
    expect(rejected).toEqual({ rejected: expect.stringMatching(/verified exact file checkpoint/) });
    expect(teamForks.rejection(core.db, source.id, request.requestKey)).toMatchObject({ requestKey: request.requestKey });
    expect(teamForks.find(core.db, source.id, "legacy-cutoff")).toBeNull();
    expect(threads.list(core.db, { projectId: project.id })).toHaveLength(1);
    expect(core.teamForks.availability(source.id)).toEqual({ allowed: true, reason: null });
    // Restoring the missing proof does not turn an already-rejected key into a fork.
    for (const ref of refs) await git(project.rootPath, ["update-ref", ref, ref.endsWith("/tree") ? checkpoints.get(core.db, selected.snapshotId!)!.treeSha : workspace.source.headSha]);
    await reopen();
    expect(await call("threads.fork", request)).toEqual(rejected);
    await expect(call("threads.fork", { ...request, upToRunId: undefined })).rejects.toThrow(/different work/);
    const child = accepted(await call("threads.fork", { ...request, requestKey: "new-valid-cutoff" }));
    expect(child.id).not.toBe(source.id);
    threads.delete(core.db, source.id);
    expect(await call("threads.fork", request)).toEqual(rejected);
    expect(teamForks.find(core.db, source.id, request.requestKey)).toBeNull();
  });

  it("returns a stable rejection when an applied fork's source and child are deleted without replacing its accepted receipt", async () => {
    const source = await team();
    await finish(source.id);
    const request = { id: source.id, requestKey: "deleted-child" };
    const child = accepted(await call("threads.fork", request));
    const receipt = teamForks.find(core.db, source.id, request.requestKey)!;
    threads.delete(core.db, source.id);
    threads.delete(core.db, child.id);
    await reopen();
    const rejected = { rejected: expect.stringMatching(/already created and later deleted/) };
    expect(await call("threads.fork", request)).toEqual(rejected);
    expect(await call("threads.fork", request)).toEqual(rejected);
    expect(teamForks.find(core.db, source.id, request.requestKey)).toEqual(receipt);
    expect(teamForks.rejection(core.db, source.id, request.requestKey)).toBeNull();
    expect(threads.list(core.db, { projectId: project.id })).toHaveLength(0);
  });

  it("drains a pre-admission failure's negative receipt before shutdown closes the database", async () => {
    const source = await team();
    await finish(source.id);
    const entered = deferred(),
      release = deferred();
    vi.spyOn(TeamWorkspaceSnapshots.prototype, "capture").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("Capture failed before admission");
    });
    const pending = core.teamForks.fork({ threadId: source.id, requestKey: "shutdown-rejection" });
    await entered.promise;
    const drained = vi.spyOn(core.teamForks, "shutdown");
    let closed = false;
    const shutdown = core.close().then(() => {
      closed = true;
      coreClosed = true;
    });
    try {
      await vi.waitFor(() => expect(drained).toHaveBeenCalled());
      expect(closed).toBe(false);
      await expect(core.teamForks.fork({ threadId: source.id, requestKey: "too-late" })).rejects.toThrow(/shutting down/);
    } finally {
      release.resolve();
    }
    expect(await pending).toEqual({ rejected: "Capture failed before admission" });
    await shutdown;
    await reopen();
    expect(teamForks.rejection(core.db, source.id, "shutdown-rejection")).toMatchObject({ error: "Capture failed before admission" });
    expect(teamForks.find(core.db, source.id, "shutdown-rejection")).toBeNull();
    expect(threads.list(core.db, { projectId: project.id })).toHaveLength(1);
  });

  it("drains an admitted fork before shutdown closes its database and writer services", async () => {
    const source = await team();
    await finish(source.id);
    const retained = deferred(),
      release = deferred();
    const service = forkService({
      fault: async (point) => {
        if (point === "retained") {
          retained.resolve();
          await release.promise;
        }
      },
    });
    const pending = service.fork({ threadId: source.id, requestKey: "shutdown-drain" });
    await retained.promise;
    let closed = false;
    const shutdown = core.close().then(() => {
      closed = true;
      coreClosed = true;
    });
    try {
      await vi.waitFor(() => expect(core.teamOperations.reason(source.id)).toMatch(/shutting down/));
      expect(closed).toBe(false);
      await expect(core.teamForks.fork({ threadId: source.id, requestKey: "after-shutdown" })).rejects.toThrow(/shutting down/);
    } finally {
      release.resolve();
    }
    const child = accepted(await pending);
    await shutdown;
    await reopen();
    expect(teamForks.find(core.db, source.id, "shutdown-drain")).toMatchObject({ state: "applied", destinationThreadId: child.id });
    expect(await call("threads.fork", { id: source.id, requestKey: "shutdown-drain" })).toMatchObject({ id: child.id });
    expect(await readFile(path.join(child.worktreePath!, "README.md"), "utf8")).toBe("# Scheduled fixture\n");
  });

  it("retains declared ignored setup input across a failed fork and the child's first execution", async () => {
    await writeFile(path.join(project.rootPath, ".gitignore"), ".env\n");
    await writeFile(path.join(project.rootPath, ".env"), "FIXTURE_VALUE=original\n");
    await call("projects.updateSettings", { id: project.id, settings: { worktreeInclude: [".env"] } });
    const source = await team();
    await finish(source.id);
    expect(await readFile(path.join(source.worktreePath!, ".env"), "utf8")).toBe("FIXTURE_VALUE=original\n");
    const faulty = forkService({
      fault: (point) => {
        if (point === "materialized") throw new Error("Keep frozen setup input");
      },
    });
    await expect(faulty.fork({ threadId: source.id, requestKey: "setup-input" })).rejects.toThrow(/Keep frozen setup input/);
    const firstPath = teamForks.find(core.db, source.id, "setup-input")!.paths[0]!;
    expect(await readFile(path.join(firstPath, ".env"), "utf8")).toBe("FIXTURE_VALUE=original\n");
    await writeFile(path.join(source.worktreePath!, ".env"), "FIXTURE_VALUE=later-source\n");
    await writeFile(path.join(project.rootPath, ".env"), "FIXTURE_VALUE=later-project\n");
    await reopen();
    const child = accepted(await core.teamForks.fork({ threadId: source.id, requestKey: "setup-input" }));
    expect(child.worktreePath).not.toBe(firstPath);
    expect(await readFile(path.join(child.worktreePath!, ".env"), "utf8")).toBe("FIXTURE_VALUE=original\n");
    await call("projects.updateSettings", { id: project.id, settings: { setupScript: "printf 'SETUP_RAN=1\\n' >> .env" } });
    const next = await followup(child.id, "Use the retained local configuration");
    expect(await readFile(path.join(next.turn.spec.cwd, ".env"), "utf8")).toBe("FIXTURE_VALUE=original\nSETUP_RAN=1\n");
    const prepared = teamWorkspaces.get(core.db, next.execution.id, "lead")!;
    expect((await teamTransfer.listTree(next.turn.spec.cwd, prepared.preparedTree!)).some((entry) => entry.path === ".env")).toBe(false);
  });

  it("retains applied replay and fresh child context after the source and its files are deleted", async () => {
    await writeFile(path.join(project.rootPath, "inherited.txt"), "Uncommitted input\n");
    const source = await team();
    await writeFile(path.join(source.worktreePath!, "inherited.txt"), "Improved inherited input\n");
    await finish(source.id);
    const child = accepted(await call("threads.fork", { id: source.id, requestKey: "surviving-child" }));
    const receipt = teamForks.byDestinationThread(core.db, child.id)!;
    expect(receipt.checkoutBaseTree).toBeTruthy();
    expect((await git(project.rootPath, ["rev-parse", `refs/openorc/forks/${receipt.id}/checkout-base`])).stdout.trim()).toBe(receipt.checkoutBaseTree);
    const pin = orchestration.getInstance(core.db, child.id)!;
    const contextBefore = teamContexts.latest(core.db, { instanceId: pin.id, executionId: null, actorId: "lead" })!;
    threads.delete(core.db, source.id);
    await rm(source.worktreePath!, { recursive: true, force: true });
    expect(await call("threads.fork", { id: source.id, requestKey: "surviving-child" })).toMatchObject({ id: child.id });
    const rebuilt = buildTeamContextSeed(core.db, { instanceId: pin.id, executionId: null, actorId: "lead" });
    expect(rebuilt).toContain("Original source requirement");
    expect(teamContexts.get(core.db, contextBefore.id)?.seed).toBe(contextBefore.seed);
    const moved = await call("threads.moveWorkspace", { id: child.id, to: "current", requestKey: "surviving-checkout-base" });
    if ("rejected" in moved) throw new Error(moved.rejected);
    expect(moved.workspaceMode).toBe("current");
    expect(await readFile(path.join(project.rootPath, "inherited.txt"), "utf8")).toBe("Improved inherited input\n");
    const next = await followup(child.id, "Continue after source deletion");
    expect(next.turn.spec.resumeSessionId).toBeUndefined();
    expect(next.turn.spec.systemPromptAppendix).toContain("Public source reply");
    expect(next.execution.instanceId).toBe(pin.id);
  });
});
