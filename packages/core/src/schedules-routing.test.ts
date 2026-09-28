import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { orchestration, projects, runs, scheduleFirings, settings, teamRuntime, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let folder: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let rpcId = 0;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-schedule-routing-"));
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
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => [
    { id: `fixture-${agent}`, label: "Scripted provider", agent: agent ?? "codex", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high", fastMode: { supported: false } },
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
async function schedule(agent: "codex" | "claude" = "codex") {
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Scheduled hierarchy",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent, model: `fixture-${agent}`, effort: "high", fastMode: false } },
        { key: "worker", name: "Worker", managerKey: "lead", responsibility: "Implement", settings: { agent: "codex", model: "fixture-codex", effort: "medium", fastMode: false } },
      ],
    },
  });
  const scheduled = await call("schedules.create", {
    projectId: project.id,
    title: "Scheduled work",
    prompt: "Inspect the project",
    executionTarget: {
      kind: "team",
      teamRevisionId: saved.revision.id,
      initialLeadOverrides: { effort: "medium" },
    },
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
    everyMinutes: 30,
  });
  return { saved, scheduled };
}
async function finish(threadId: string) {
  const record = teamRuntime.activeForThread(core.db, threadId)!;
  await core.teams.drain();
  const attempt = core.teams.status(record.id).attempts.at(-1)!;
  const turn = turns.get(attempt.runId!)!;
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text: "Scheduled work completed", ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now() });
  await vi.waitFor(() => expect(core.teams.status(record.id).state).toBe("completed"), { timeout: 10000 });
  await core.teams.drain();
}

describe("scheduled admission through real services and scripted providers", () => {
  it.each(["claude"] as const)("launches archived pinned %s revision, blocks unfinished teams, and starts a fresh instance next time", async (agent) => {
    const { saved, scheduled } = await schedule(agent);
    await call("orchestration.archive", { projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: true });
    const first = await call("schedules.trigger", { id: scheduled.id, requestKey: "first" });
    expect(first.status).toBe("started");
    if (first.status !== "started") throw new Error(first.reason);
    await core.teams.drain();
    expect([...turns.values()][0]?.spec).toMatchObject({ agent, model: `fixture-${agent}`, effort: "medium" });
    expect(runs.get(core.db, [...turns.values()][0]!.spec.runId)?.mode).toBe("act");
    expect([...turns.values()][0]?.spec.cwd).not.toBe(project.rootPath);
    expect(await call("schedules.trigger", { id: scheduled.id, requestKey: "first" })).toMatchObject({ status: "started", thread: { id: first.thread.id } });
    expect(await call("schedules.trigger", { id: scheduled.id, requestKey: "overlap" })).toMatchObject({ status: "skipped" });
    await finish(first.thread.id);
    const second = await call("schedules.trigger", { id: scheduled.id, requestKey: "second" });
    if (second.status !== "started") throw new Error(second.reason);
    await core.teams.drain();
    const a = orchestration.getInstance(core.db, first.thread.id)!,
      b = orchestration.getInstance(core.db, second.thread.id)!;
    expect(a.id).not.toBe(b.id);
    expect(a.teamRevisionId).toBe(b.teamRevisionId);
    expect(a.members.map((member) => member.id).some((id) => b.members.some((member) => member.id === id))).toBe(false);
    expect(scheduleFirings.list(core.db, scheduled.id).map((item) => item.state)).toEqual(["started", "skipped", "started"]);
    expect(turns.size).toBe(2);
  });

  it("keeps a solo receipt admitted when actual workspace setup fails and exposes the failed run on replay", async () => {
    const scheduled = await call("schedules.create", {
      projectId: project.id,
      title: "Solo",
      prompt: "Inspect",
      agent: "codex",
      model: "fixture-codex",
      effort: "medium",
      mode: "act",
      permissionMode: "trusted",
      workspaceMode: "worktree",
      everyMinutes: 30,
    });
    const preparation = vi.spyOn(core.workspaces, "prepareThread").mockRejectedValueOnce(new Error("Scripted worktree setup failed"));
    const first = await call("schedules.trigger", { id: scheduled.id, requestKey: "solo" });
    if (first.status !== "started") throw new Error(first.reason);
    expect(runs.listForThread(core.db, first.thread.id)).toEqual([expect.objectContaining({ state: "error" })]);
    expect(pushed.some((message) => message.type === "invalidate" && message.keys.includes(`runs:thread:${first.thread.id}`))).toBe(true);
    expect(await call("schedules.trigger", { id: scheduled.id, requestKey: "solo" })).toMatchObject({ status: "started", thread: { id: first.thread.id } });
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(turns.size).toBe(0);
    expect(threads.list(core.db, { projectId: project.id })).toHaveLength(1);
  });

  it("revalidates the preview gate after provider preflight before creating any team record", async () => {
    const { scheduled } = await schedule();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(core.orchestration, "preflight").mockImplementation(async () => {
      await held;
      return { ready: true, issues: [] };
    });
    const pending = call("schedules.trigger", { id: scheduled.id, requestKey: "gate" });
    await call("app.settings.set", { experimentalTeamExecution: false });
    release();
    expect(await pending).toMatchObject({ status: "failed", reason: expect.stringContaining("disabled") });
    expect(threads.list(core.db, { projectId: project.id })).toHaveLength(0);
    expect(teamRuntime.listOpen(core.db)).toHaveLength(0);
    expect(turns.size).toBe(0);
  });
});
