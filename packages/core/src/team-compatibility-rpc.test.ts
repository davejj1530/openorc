import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { memories, orchestration, projects, runs, settings, tasks, teamRuntime, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { Embedder } from "@openorc/memory";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec, type Usage } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let folder: string;
let root: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let rpcId = 0;
const member = (key: string, managerKey: string | null) => ({
  key,
  name: key === "lead" ? "Lead" : "Worker Wren",
  managerKey,
  responsibility: `Do ${key} work`,
  settings: { agent: "codex" as const, model: "fixture-codex", effort: "high", fastMode: false },
});

beforeEach(async () => {
  // Recording a memory embeds it; with no cached model that downloads ~87 MB. Tests stay offline and use full-text search.
  vi.spyOn(Embedder.prototype, "ready").mockResolvedValue(false);
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-compatibility-"));
  root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Compatibility fixture\n");
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
  // Agents get memory tools only while memory is on; runs are not summarized.
  settings.set(core.db, "memory.enabled", "true");
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
async function liveRun(executionId: string, actorId: string) {
  await vi.waitFor(() => expect(core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")?.runId).toBeTruthy(), { timeout: 15000 });
  const runId = core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")!.runId!;
  return { runId, ...turns.get(runId)! };
}
function endTurn(turn: { spec: RunSpec; handle: RunHandle }, text: string, usage?: Usage) {
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now(), ...(usage ? { usage } : {}) });
}
async function mcpCall(runId: string, name: string, args: Record<string, unknown>) {
  const url = (await core.mcpServer()).urlForRun(runId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(4000),
  });
  const raw = await response.text();
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
  ) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result?.isError) throw new Error(payload.result.content[0]?.text);
  return JSON.parse(payload.result!.content[0]!.text) as Record<string, unknown>;
}
async function saveTeam(name = "Compatibility team") {
  return call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name, limits: { ...DEFAULT_TEAM_LIMITS }, discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] }, members: [member("lead", null), member("worker", "lead")] },
  });
}
async function startTeam(prompt: string, extra: Partial<RpcParams<"threads.start">> = {}) {
  const saved = await saveTeam();
  const { thread } = await call("threads.start", {
    projectId: project.id,
    executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
    mode: "act",
    permissionMode: "trusted",
    prompt,
    ...extra,
  });
  await core.teams.drain();
  return { thread, execution: teamRuntime.activeForThread(core.db, thread.id)! };
}
const exists = (file: string) =>
  readFile(file, "utf8").then(
    () => true,
    () => false,
  );

describe("compatibility matrix rows through the public boundary", () => {
  it("launches a team from a chosen base commit rather than the checkout's current files, pins it for replay and refuses unknown bases", async () => {
    await git(root, ["checkout", "-q", "-b", "release/base"]);
    await writeFile(path.join(root, "release.txt"), "committed on the base branch\n");
    await commitAll(root, "Release base");
    const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, ["checkout", "-q", "main"]);
    await writeFile(path.join(root, "local-only.txt"), "uncommitted work in the checkout\n");
    const saved = await saveTeam();
    const launch = (baseRef: string, requestKey = "base-launch") =>
      call("threads.start", {
        projectId: project.id,
        requestKey,
        executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
        mode: "act",
        permissionMode: "trusted",
        prompt: "Start from the release base",
        baseRef,
      });
    await expect(launch("nope/missing", "base-missing")).rejects.toThrow(/was not found in the project repository/);
    await expect(launch("--output=/tmp/x", "base-flag")).rejects.toThrow(/must name a branch, tag or commit/);
    expect(teamRuntime.findAdmission(core.db, { scope: "project", projectId: project.id, requestKey: "base-missing" })).toBeNull();
    const { thread } = await launch("release/base");
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "worktree", baseSha });
    await core.teams.drain();
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const lead = await liveRun(execution.id, "lead");
    expect(await readFile(path.join(lead.spec.cwd, "release.txt"), "utf8")).toBe("committed on the base branch\n");
    expect(await exists(path.join(lead.spec.cwd, "local-only.txt"))).toBe(false);
    expect((await git(lead.spec.cwd, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);
    expect((await git(lead.spec.cwd, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).code).toBe(1);
    // A replay of the same key returns the same thread; the same key with another base is different work.
    expect((await launch("release/base")).thread.id).toBe(thread.id);
    await expect(launch("main")).rejects.toThrow(/different work/);
    // The worker inherits the lead's exact input; the base commit is the diff base.
    const worker = core.teams.dispatch(lead.runId, { memberKey: "worker", requestKey: "w", title: "Worker change", spec: "Add a file", dependencies: [], attachments: [] });
    core.teams.wait(lead.runId, { assignmentIds: [worker.id] });
    endTurn(lead, "Delegated");
    const workerTurn = await liveRun(execution.id, worker.id);
    expect(await readFile(path.join(workerTurn.spec.cwd, "release.txt"), "utf8")).toBe("committed on the base branch\n");
    expect(await exists(path.join(workerTurn.spec.cwd, "local-only.txt"))).toBe(false);
    await writeFile(path.join(workerTurn.spec.cwd, "worker.txt"), "worker output\n");
    core.teams.complete(workerTurn.runId, { result: "Added worker.txt" });
    endTurn(workerTurn, "Done");
    const resumed = await liveRun(execution.id, "lead");
    core.teams.complete(resumed.runId, { result: "Integrated" });
    endTurn(resumed, "Integrated");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    const diff = await call("review.threadDiff", { threadId: thread.id });
    expect(diff.baseSha).toBe(baseSha);
    expect(diff.patch).toContain("+worker output");
    expect(diff.patch).not.toContain("uncommitted work");
    expect(await readFile(path.join(root, "local-only.txt"), "utf8")).toBe("uncommitted work in the checkout\n");
    // Ordinary team launches still start from the checkout's current files.
    const plain = await startTeam("Start from the checkout");
    const plainLead = await liveRun(plain.execution.id, "lead");
    expect(await exists(path.join(plainLead.spec.cwd, "local-only.txt"))).toBe(true);
    expect(threads.get(core.db, plain.thread.id)?.baseSha).toBe((await git(root, ["rev-parse", "HEAD"])).stdout.trim());
  });

  it("attributes search hits to the member and task that said them, keeps imports as model threads, and hides deleted owners", async () => {
    const { thread, execution } = await startTeam("Build the search fixture");
    const lead = await liveRun(execution.id, "lead");
    const worker = core.teams.dispatch(lead.runId, { memberKey: "worker", requestKey: "w", title: "Index the corpus", spec: "Index", dependencies: [], attachments: [] });
    core.teams.wait(lead.runId, { assignmentIds: [worker.id] });
    endTurn(lead, "Delegating the zebrafish indexing to the worker.");
    const workerTurn = await liveRun(execution.id, worker.id);
    core.teams.complete(workerTurn.runId, { result: "Indexed" });
    endTurn(workerTurn, "The zebrafish index is complete.");
    const resumed = await liveRun(execution.id, "lead");
    core.teams.complete(resumed.runId, { result: "Done" });
    endTurn(resumed, "Zebrafish work is integrated.");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    const hits = await call("threads.search", { query: "zebrafish", projectId: project.id });
    expect(hits.map((hit) => hit.runId).sort()).toEqual([lead.runId, workerTurn.runId, resumed.runId].sort());
    expect(hits.every((hit) => hit.threadId === thread.id && hit.role === "assistant")).toBe(true);
    expect(hits.find((hit) => hit.runId === workerTurn.runId)).toMatchObject({ taskId: worker.taskId, taskTitle: "Index the corpus", member: { key: "worker", name: "Worker Wren" } });
    expect(hits.find((hit) => hit.runId === lead.runId)).toMatchObject({ taskId: null, taskTitle: null, member: { key: "lead", name: "Lead" } });
    // A project search never crosses projects, and a deleted owner disappears from results.
    const other = projects.insert(core.db, { name: "Other", rootPath: path.join(folder, "other"), defaultBranch: "main", gitRemote: null, settings: {} });
    expect(await call("threads.search", { query: "zebrafish", projectId: other.id })).toEqual([]);
    expect(await call("threads.delete", { id: thread.id, requestKey: "delete-search" })).toBeNull();
    expect(await call("threads.search", { query: "zebrafish", projectId: project.id })).toEqual([]);
    // Imported CLI sessions stay ordinary model threads even in a project with saved teams, and their text is searchable without attribution.
    const home = await mkdtemp(path.join(os.tmpdir(), "openorc-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const { claudeProjectDir } = await import("@openorc/agents");
      const dir = claudeProjectDir(project.rootPath, home);
      await mkdir(dir, { recursive: true });
      const rows = [
        { type: "user", sessionId: "s-9", cwd: project.rootPath, timestamp: "2026-09-01T10:00:00.000Z", uuid: "u1", message: { role: "user", content: "Rename the quokka module" } },
        { type: "assistant", sessionId: "s-9", timestamp: "2026-09-01T10:00:05.000Z", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "Renamed the quokka module." }] } },
      ];
      await writeFile(path.join(dir, "s-9.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const found = await core.imports.importable(project.id);
      const [imported] = await core.imports.import(project.id, [{ agent: "claude", path: found[0]!.path }]);
      expect(orchestration.getInstance(core.db, imported!.id)).toBeNull();
      expect(await call("threads.get", { id: imported!.id })).toMatchObject({ teamInstanceId: null, importedFrom: found[0]!.path });
      const importedHits = await call("threads.search", { query: "quokka", projectId: project.id });
      expect(importedHits.map((hit) => hit.role).sort()).toEqual(["assistant", "user"]);
      expect(importedHits.every((hit) => hit.threadId === imported!.id && hit.taskId === null && hit.member === null)).toBe(true);
      expect((await call("threads.list", { projectId: project.id })).find((item) => item.id === imported!.id)?.teamInstanceId).toBeNull();
    } finally {
      process.env["HOME"] = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps memory provenance on the member run and task, charges cost only to the assignment's task, and reads context per run", async () => {
    const { thread, execution } = await startTeam("Build the usage fixture");
    const lead = await liveRun(execution.id, "lead");
    const worker = core.teams.dispatch(lead.runId, { memberKey: "worker", requestKey: "w", title: "Measure things", spec: "Measure", dependencies: [], attachments: [] });
    core.teams.wait(lead.runId, { assignmentIds: [worker.id] });
    endTurn(lead, "Delegated", { inputTokens: 100, outputTokens: 20, costUsd: 0.5, contextTokens: 40_000, contextWindow: 200_000 });
    const workerTurn = await liveRun(execution.id, worker.id);
    const recorded = await mcpCall(workerTurn.runId, "memory_record", { type: "decision", title: "Measure with the shared harness", body: "The worker measured with the shared harness." });
    const memory = memories.get(core.db, recorded["id"] as string)!;
    expect(memory).toMatchObject({ projectId: project.id, source: "agent", sourceRunId: workerTurn.runId, sourceTaskId: worker.taskId });
    core.teams.complete(workerTurn.runId, { result: "Measured" });
    endTurn(workerTurn, "Measured", { inputTokens: 300, outputTokens: 30, costUsd: 0.25, contextTokens: 9_000, contextWindow: 128_000 });
    const resumed = await liveRun(execution.id, "lead");
    endTurn(resumed, "Reviewing", { inputTokens: 50, outputTokens: 5, contextTokens: 45_000, contextWindow: 200_000 });
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("active"), { timeout: 15000 });
    await vi.waitFor(() => expect(core.runs.threadContext(thread.id)).toEqual({ used: 45_000, window: 200_000 }), { timeout: 15000 });
    // Cost lands once on the assignment's task; lead turns without a task or without a reported cost add nothing anywhere.
    expect(tasks.get(core.db, worker.taskId!)!.costUsd).toBeCloseTo(0.25);
    expect(
      tasks
        .list(core.db, { projectId: project.id })
        .filter((task) => task.id !== worker.taskId)
        .every((task) => task.costUsd === 0),
    ).toBe(true);
    const runs = await call("runs.listForThread", { threadId: thread.id });
    expect(runs.map((run) => run.usage?.contextTokens)).toEqual([40_000, 45_000]);
    expect((await call("runs.listForTask", { taskId: worker.taskId! })).map((run) => run.usage)).toEqual([expect.objectContaining({ costUsd: 0.25, contextTokens: 9_000, contextWindow: 128_000 })]);
    expect(core.runs.threadContext(thread.id)).toEqual({ used: 45_000, window: 200_000 });
  });
  it("charges a task only what a resumed provider session cost after it resumed", async () => {
    const { execution } = await startTeam("Build the resumed cost fixture");
    const lead = await liveRun(execution.id, "lead");
    const worker = core.teams.dispatch(lead.runId, { memberKey: "worker", requestKey: "w", title: "Measure again", spec: "Measure", dependencies: [], attachments: [] });
    core.teams.wait(lead.runId, { assignmentIds: [worker.id] });
    endTurn(lead, "Delegated");
    // An earlier run of the same provider session already reported $0.10; providers report running totals.
    const earlierThread = threads.insert(core.db, { projectId: project.id, title: "Earlier", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const earlier = runs.insert(core.db, { id: "earlier-run", taskId: null, threadId: earlierThread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    runs.update(core.db, earlier.id, { externalSessionId: "worker-session", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 } });
    const workerTurn = await liveRun(execution.id, worker.id);
    workerTurn.handle.emit("event", { type: "session.started", runId: workerTurn.runId, ts: Date.now(), agent: "codex", externalSessionId: "worker-session", model: null });
    core.teams.complete(workerTurn.runId, { result: "Measured" });
    endTurn(workerTurn, "Measured", { inputTokens: 300, outputTokens: 30, costUsd: 0.35 });
    await vi.waitFor(() => expect(tasks.get(core.db, worker.taskId!)!.costUsd).toBeCloseTo(0.25), { timeout: 15000 });
  });
});
