import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, settings, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec, type TeamConversation } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

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
const member = (key: string, managerKey: string | null) => ({
  key,
  name: key,
  managerKey,
  responsibility: `Do ${key} work`,
  settings: { agent: "codex" as const, model: "fixture-codex", effort: "high", fastMode: false },
});

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-recovery-rpc-"));
  root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Recovery fixture\n");
  await writeFile(path.join(root, "shared.txt"), "original line\n");
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
async function startTeam(members: ReturnType<typeof member>[], prompt: string) {
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Recovery team", limits: { ...DEFAULT_TEAM_LIMITS, maxConcurrentAgents: 3 }, discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] }, members },
  });
  const { thread } = await call("threads.start", { projectId: project.id, executionTarget: { kind: "team", teamRevisionId: saved.revision.id }, mode: "act", permissionMode: "trusted", prompt });
  await core.teams.drain();
  return thread;
}
const runtime = (threadId: string) => call("orchestration.runtime", { threadId }) as Promise<TeamConversation>;
const actorView = async (threadId: string, actorId: string) => (await runtime(threadId)).executions.at(-1)!.actors.find((actor) => actor.id === actorId)!;
async function liveRun(executionId: string, actorId: string) {
  await vi.waitFor(() => expect(core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")?.runId).toBeTruthy(), { timeout: 15000 });
  const runId = core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")!.runId!;
  return { runId, ...turns.get(runId)! };
}
function endTurn(turn: { spec: RunSpec; handle: RunHandle }, text: string) {
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now() });
}
const attention = (executionId: string, actorId: string) =>
  vi.waitFor(() => expect(core.teams.status(executionId).actors.find((actor) => actor.id === actorId)?.state).toBe("attention"), { timeout: 15000 });

describe("explicit setup and integration recovery through the public boundary", () => {
  it("recovers a failed lead setup in a new directory and then runs the retried assignment", async () => {
    projects.updateSettings(core.db, project.id, { setupScript: 'test -f "$OPENORC_ROOT_PATH/.setup-ok" || exit 9' });
    const thread = await startTeam([member("lead", null)], "Build it");
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    await attention(execution.id, "lead");
    let lead = await actorView(thread.id, "lead");
    expect(lead.workspace).toMatchObject({
      state: "attention",
      setupState: "blocked",
      recovery: { retrySetup: { allowed: true }, acceptSetup: { allowed: false }, sourceChanged: false, retiredPaths: [] },
    });
    expect(lead.retry).toMatchObject({ allowed: false, reason: expect.stringMatching(/exited with 9/) });
    const failedPath = lead.workspace!.path;
    await expect(call("orchestration.workspace.acceptSetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "accept-1" })).rejects.toThrow(/nothing to accept/);
    await writeFile(path.join(root, ".setup-ok"), "");
    const recovered = await call("orchestration.workspace.retrySetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "retry-1" });
    lead = recovered.executions.at(-1)!.actors[0]!;
    expect(lead.workspace).toMatchObject({ state: "ready", setupState: "completed" });
    expect(lead.workspace!.recovery).toBeUndefined();
    expect(lead.workspace!.path).not.toBe(failedPath);
    expect(await exists(failedPath)).toBe(true);
    expect(lead.retry.allowed).toBe(true);
    expect(teamWorkspaces.get(core.db, execution.id, "lead")).toMatchObject({ retired: [{ path: failedPath }], recovery: [{ requestKey: "retry-1", kind: "retry-setup" }] });
    expect(threads.get(core.db, thread.id)?.worktreePath).toBe(lead.workspace!.path);
    // A replayed key changes nothing; a second recovery is refused once the workspace is ready.
    await call("orchestration.workspace.retrySetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "retry-1" });
    await expect(call("orchestration.workspace.retrySetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "retry-2" })).rejects.toThrow(/not blocked/i);
    await call("orchestration.retry", { threadId: thread.id, executionId: execution.id, actorId: "lead" });
    const turn = await liveRun(execution.id, "lead");
    expect(await realpath(turn.spec.cwd)).toBe(await realpath(lead.workspace!.path));
    endTurn(turn, "Built");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
  });

  it("accepts a source-changing setup and starts the assignment from the prepared files", async () => {
    projects.updateSettings(core.db, project.id, { setupScript: 'printf "generated by setup\\n" > README.md' });
    const thread = await startTeam([member("lead", null)], "Build it");
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    await attention(execution.id, "lead");
    let lead = await actorView(thread.id, "lead");
    expect(lead.workspace?.recovery).toMatchObject({ retrySetup: { allowed: true }, acceptSetup: { allowed: true }, sourceChanged: true });
    await expect(call("orchestration.workspace.acceptSetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "" })).rejects.toThrow();
    const accepted = await call("orchestration.workspace.acceptSetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "accept-1" });
    lead = accepted.executions.at(-1)!.actors[0]!;
    expect(lead.workspace).toMatchObject({ state: "ready", setupState: "completed" });
    expect(teamWorkspaces.get(core.db, execution.id, "lead")?.setupAccepted).toMatchObject({ acceptedAt: expect.any(Number) });
    await call("orchestration.retry", { threadId: thread.id, executionId: execution.id, actorId: "lead" });
    const turn = await liveRun(execution.id, "lead");
    expect(await readFile(path.join(turn.spec.cwd, "README.md"), "utf8")).toBe("generated by setup\n");
    endTurn(turn, "Built on the prepared files");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Recovery fixture\n");
  });

  it("lets the user resolve a worker conflict in the scratch worktree, accept it, and resume the lead", async () => {
    const thread = await startTeam([member("lead", null), member("a", "lead"), member("b", "lead")], "Split the work");
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const leadTurn = await liveRun(execution.id, "lead");
    const workerA = core.teams.dispatch(leadTurn.runId, { memberKey: "a", requestKey: "a", title: "A", spec: "Write shared.txt", dependencies: [], attachments: [] });
    const workerB = core.teams.dispatch(leadTurn.runId, { memberKey: "b", requestKey: "b", title: "B", spec: "Write shared.txt too", dependencies: [], attachments: [] });
    core.teams.wait(leadTurn.runId, { assignmentIds: [workerA.id, workerB.id] });
    endTurn(leadTurn, "Delegated");
    for (const [worker, line] of [
      [workerA, "line from a\n"],
      [workerB, "line from b\n"],
    ] as const) {
      const turn = await liveRun(execution.id, worker.id);
      await writeFile(path.join(turn.spec.cwd, "shared.txt"), line);
      core.teams.complete(turn.runId, { result: `${worker.memberKey} wrote shared.txt` });
      endTurn(turn, "Done");
      await vi.waitFor(() => expect(core.teams.status(execution.id).actors.find((actor) => actor.id === worker.id)?.state).toBe("completed"), { timeout: 15000 });
    }
    await attention(execution.id, "lead");
    let view = (await runtime(thread.id)).executions.at(-1)!;
    const conflict = view.publications.find((receipt) => receipt.state === "conflict")!;
    expect(conflict.recovery).toMatchObject({ retry: { allowed: true }, accept: { allowed: true }, conflicts: ["shared.txt"], retiredScratchPaths: [] });
    expect(view.publications.filter((receipt) => receipt.state === "applied")).toHaveLength(1);
    expect(view.actors[0]!.retry).toMatchObject({ allowed: false, reason: expect.stringMatching(/Resolve and accept|conflict/i) });
    await expect(call("orchestration.integration.accept", { threadId: thread.id, executionId: execution.id, publicationId: conflict.id, requestKey: "accept-1" })).rejects.toThrow(/conflict markers/);
    await writeFile(path.join(conflict.scratchPath, "shared.txt"), "line from a\nline from b\n");
    const accepted = await call("orchestration.integration.accept", { threadId: thread.id, executionId: execution.id, publicationId: conflict.id, requestKey: "accept-1" });
    view = accepted.executions.at(-1)!;
    expect(view.publications.map((receipt) => receipt.state)).toEqual(["applied", "applied"]);
    expect(view.publications.find((receipt) => receipt.id === conflict.id)?.recovery).toBeUndefined();
    expect(view.actors[0]!.retry.allowed).toBe(true);
    await expect(call("orchestration.integration.retry", { threadId: thread.id, executionId: execution.id, publicationId: conflict.id, requestKey: "retry-after" })).rejects.toThrow(/already applied/);
    await call("orchestration.retry", { threadId: thread.id, executionId: execution.id, actorId: "lead" });
    const resumed = await liveRun(execution.id, "lead");
    expect(await readFile(path.join(resumed.spec.cwd, "shared.txt"), "utf8")).toBe("line from a\nline from b\n");
    core.teams.complete(resumed.runId, { result: "Integrated" });
    endTurn(resumed, "Integrated");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    expect(await readFile(path.join(root, "shared.txt"), "utf8")).toBe("original line\n");
  });

  it("refuses recovery while the team is stopping or a workspace operation fences it, and stops wait for a running retry", async () => {
    projects.updateSettings(core.db, project.id, { setupScript: 'test -f "$OPENORC_ROOT_PATH/.setup-ok" || exit 9' });
    const thread = await startTeam([member("lead", null)], "Build it");
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    await attention(execution.id, "lead");
    projects.updateSettings(core.db, project.id, { setupScript: 'until test -f "$OPENORC_ROOT_PATH/.release"; do sleep 0.05; done' });
    const running = call("orchestration.workspace.retrySetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "slow" });
    await vi.waitFor(() => expect(teamWorkspaces.get(core.db, execution.id, "lead")?.setupState).toBe("running"), { timeout: 15000 });
    expect(core.teamWorkspaces.pendingRecoveries(execution.id)).toHaveLength(1);
    expect(core.teamMoves.availability(thread.id)).toMatchObject({ allowed: false, reason: expect.stringMatching(/recovery is still running|unfinished execution/i) });
    const stopping = call("orchestration.stop", { threadId: thread.id, executionId: execution.id });
    await writeFile(path.join(root, ".release"), "");
    const stopped = await stopping;
    expect(stopped.executions.at(-1)!.state).toBe("stopped");
    await expect(running).rejects.toThrow(/stopped or replaced|Recovery did not continue|shutting down/);
    const record = teamWorkspaces.get(core.db, execution.id, "lead")!;
    expect(record.state).toBe("attention");
    expect(record.retired).toHaveLength(1);
    await expect(call("orchestration.workspace.retrySetup", { threadId: thread.id, executionId: execution.id, actorId: "lead", requestKey: "after-stop" })).rejects.toThrow(
      /not open for recovery|stopped/i,
    );
  });
});
