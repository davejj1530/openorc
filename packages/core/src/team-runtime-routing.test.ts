import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAdapter, ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { checkpoints, memories, orchestration, projects, runs, settings, tasks, teamContexts, teamTasks, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git, teamTransfer } from "@openorc/git";
import {
  DEFAULT_TEAM_LIMITS,
  TeamExecutionRecord,
  type CorePush,
  type Project,
  type RpcMethod,
  type RpcParams,
  type RpcResults,
  type RunSpec,
  type TeamDraft,
  type Thread,
  type HarnessId,
} from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { ShellEnvironment } from "./services/shell-environment.js";
import { SystemService, type CommandProbe } from "./services/system.js";

interface ScriptedTurn {
  spec: RunSpec;
  handle: RunHandle;
  exited: boolean;
}
let core: OpenOrc;
let directory: string;
let root: string;
let project: Project;
let pushed: CorePush[];
let scripted: Map<string, ScriptedTurn>;
let executions: string[];
let rpcId = 0;
let liveSteering = false;
const liveDelivery = vi.fn<(text: string, attachments?: string[]) => Promise<"accepted" | "unavailable">>();

function draft(agent: HarnessId = "codex", includeWorker = false): TeamDraft {
  return {
    name: "Routing proof",
    limits: { ...DEFAULT_TEAM_LIMITS },
    discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
    members: [
      {
        key: "lead",
        name: "Lead",
        responsibility: "Coordinate the requested work",
        managerKey: null,
        settings: { agent, model: agent === "opencode" ? "openrouter/acme/fast" : `fixture-${agent}`, effort: agent === "opencode" ? null : "high", fastMode: false },
      },
      ...(includeWorker
        ? [
            {
              key: "worker",
              name: "Worker",
              responsibility: "Implement assigned work",
              managerKey: "lead",
              settings: { agent: "claude" as const, model: "fixture-claude", effort: "medium", fastMode: false },
            },
          ]
        : []),
    ],
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-team-routing-"));
  root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Routing fixture\n");
  await commitAll(root, "Fixture baseline");
  scripted = new Map();
  pushed = [];
  executions = [];
  liveSteering = false;
  liveDelivery.mockReset().mockResolvedValue("accepted");
  const start = (spec: RunSpec): RunHandle => {
    let resolve!: (code: number) => void;
    const done = new Promise<number>((next) => {
      resolve = next;
    });
    const turn: ScriptedTurn = {
      spec,
      exited: false,
      handle: new RunHandle(spec.runId, {
        done,
        send: async () => {
          throw new Error("Team messages must use the coordinator mailbox");
        },
        interrupt() {},
        ...(spec.agent === "codex" ? { steer: liveDelivery, canSteer: () => liveSteering } : {}),
        close() {
          if (turn.exited) return;
          turn.exited = true;
          turn.handle.emit("exit", 0);
          resolve(0);
        },
      }),
    };
    scripted.set(spec.runId, turn);
    return turn.handle;
  };
  // Real core and MCP HTTP transport; only external provider boundaries are scripted.
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(start);
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(start);
  vi.spyOn(AcpAdapter.prototype, "start").mockImplementation(start);
  core = await OpenOrc.create({ dataDir: path.join(directory, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  const environment = core.environment.current();
  vi.spyOn(core.environment, "current").mockReturnValue({ ...environment, binaries: { codex: "/fixture/codex", claude: "/fixture/claude", opencode: "/fixture/opencode" } });
  // Agents get memory tools only while memory is on; runs are not summarized.
  settings.set(core.db, "memory.enabled", "true");
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) =>
    [agent ?? "codex"].map((provider) => ({
      id: provider === "opencode" ? "openrouter/acme/fast" : `fixture-${provider}`,
      label: "Scripted provider",
      agent: provider,
      isDefault: true,
      efforts: ["medium", "high"],
      defaultEffort: "high",
      fastMode: { supported: false },
    })),
  );
});

afterEach(async () => {
  if (core) {
    for (const id of executions) await core.teams.stop(id);
    await core.teams.drain();
    await core.close();
  }
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function newThread(agent: HarnessId = "codex"): Thread {
  return threads.insert(core.db, {
    projectId: project.id,
    title: "Routing proof",
    agent,
    model: `fixture-${agent}`,
    effort: "high",
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "worktree",
  });
}

async function startTeam(teamDraft = draft(), thread = newThread(teamDraft.members[0]!.settings.agent)) {
  const saved = orchestration.save(core.db, { projectId: project.id, expectedRevisionId: null, draft: teamDraft });
  const execution = await core.teams.start({ threadId: thread.id, teamRevisionId: saved.revision.id, prompt: "Coordinate this isolated routing proof." });
  executions.push(execution.id);
  await core.teams.drain();
  return { execution: core.teams.status(execution.id), thread, saved, turn: leadTurn(execution.id) };
}

async function startPublic(teamDraft = draft(), initialLeadOverrides: { effort?: string | null; fastMode?: boolean } = {}) {
  await call("app.settings.set", { experimentalTeamExecution: true });
  const saved = orchestration.save(core.db, { projectId: project.id, expectedRevisionId: null, draft: teamDraft });
  const result = await call("threads.start", {
    projectId: project.id,
    executionTarget: { kind: "team", teamRevisionId: saved.revision.id, initialLeadOverrides },
    mode: "act",
    permissionMode: "trusted",
    prompt: "The user's original team request.",
  });
  expect(result.run).toBeNull();
  const runtime = (await call("orchestration.runtime", { threadId: result.thread.id }))!;
  const execution = runtime.executions[0]!;
  executions.push(execution.id);
  await core.teams.drain();
  return { ...result, saved, execution, runtime };
}

function leadTurn(executionId: string): ScriptedTurn {
  return actorTurn(executionId, "lead");
}

function actorTurn(executionId: string, actorId: string): ScriptedTurn {
  const runId = core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.runId)?.runId;
  if (!runId || !scripted.has(runId)) throw new Error(`Actor ${actorId} did not start through the scripted provider`);
  return scripted.get(runId)!;
}

async function mcpCall(runId: string, name: string, args: Record<string, unknown> = {}) {
  const url = (await core.mcpServer()).urlForRun(runId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(4000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw}`);
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
  );
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result.isError) throw new Error(payload.result.content.map((item: { text?: string }) => item.text ?? "").join("\n"));
  return JSON.parse(payload.result.content[0].text);
}

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++rpcId;
  await core.handle({ type: "rpc", id, method, params });
  const response = pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);
  if (!response || (response.type !== "rpc.result" && response.type !== "rpc.error")) throw new Error("No RPC response");
  if (response.type === "rpc.error") throw new Error(response.message);
  return response.result as RpcResults[M];
}

function emitFinish(turn: ScriptedTurn) {
  const { runId, agent, model } = turn.spec;
  turn.handle.emit("event", { type: "session.started", runId, ts: Date.now(), agent, model: model ?? "fixture", externalSessionId: `session-${runId}` });
  turn.handle.emit("event", { type: "message.completed", runId, ts: Date.now(), messageId: `reply-${runId}`, role: "assistant", text: "Scripted response" });
  turn.handle.emit("event", { type: "turn.completed", runId, ts: Date.now(), turnId: `turn-${runId}`, status: "success", durationMs: 1 });
}

async function finish(turn: ScriptedTurn, executionId: string, state: "waiting" | "completed", actorId = "lead") {
  emitFinish(turn);
  await vi.waitFor(() => expect(core.teams.status(executionId).actors.find((actor) => actor.id === actorId)?.state).toBe(state), { timeout: 10_000 });
  await core.teams.drain();
}

async function readinessProbes(loggedIn = () => true) {
  const probe = vi.fn(async () => ({ path: "/usr/bin", binaries: { codex: "/fixture/codex", claude: "/fixture/claude", opencode: null } }));
  const environment = new ShellEnvironment({ env: { PATH: "/usr/bin" }, probe, shell: () => "/bin/sh" });
  await environment.refresh();
  const command = vi.fn<CommandProbe>(async (binary, args) => ({
    status: "ok",
    output: probeOutput(binary, args, loggedIn),
  }));
  const system = new SystemService(directory, environment, command);
  vi.mocked(core.orchestration.preflight).mockRestore();
  vi.spyOn(core.system, "info").mockImplementation((refresh) => system.info(refresh));
  await system.info();
  probe.mockClear();
  command.mockClear();
  return { probe, command };
}

describe("team runtime through the core and real MCP server", () => {
  it("starts team turns without repeating recent shell and provider probes, but refreshes explicit readiness checks", async () => {
    const { probe, command } = await readinessProbes();
    await Promise.all([startTeam(draft("codex")), startTeam(draft("claude"))]);
    expect(scripted.size).toBe(2);
    expect(probe).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();

    expect(await call("orchestration.preflight", { projectId: project.id, draft: draft() })).toEqual({ ready: true, issues: [] });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(4);
  });

  it("refreshes a stale failed readiness check before rejecting a team turn", async () => {
    let loggedIn = false;
    const { probe } = await readinessProbes(() => loggedIn);
    loggedIn = true;
    await startTeam();
    expect(scripted.size).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("prioritizes a worker approval over running siblings without changing another team's activity", async () => {
    const team = draft("codex", true);
    team.members.push({ key: "reviewer", name: "Reviewer", managerKey: "lead", responsibility: "Review", settings: team.members[1]!.settings });
    const started = await startPublic(team);
    const lead = leadTurn(started.execution.id);
    const ids: string[] = [];
    for (const member of ["worker", "reviewer"]) {
      const delegated = await mcpCall(lead.spec.runId, "task_create", { title: `${member} work`, spec: "Perform this work", execution: "delegate", member_key: member, request_key: member });
      ids.push(core.teams.status(started.execution.id).actors.find((actor) => actor.taskId === delegated.task.id)!.id);
    }
    await mcpCall(lead.spec.runId, "team_wait", { assignment_ids: ids });
    await finish(lead, started.execution.id, "waiting");
    const worker = actorTurn(started.execution.id, ids[0]!);
    expect(actorTurn(started.execution.id, ids[1]!).exited).toBe(false);
    const other = await startPublic();
    const answer = core.runs.requestApproval(worker.spec.runId, "worker-approval", "Bash", { command: "fixture command" });
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))?.executions[0]!.activity).toBe("waiting");
    expect((await call("threads.get", { id: started.thread.id }))?.activity).toBe("waiting");
    expect((await call("orchestration.runtime", { threadId: other.thread.id }))?.executions[0]!.activity).toBe("working");
    expect((await call("threads.get", { id: other.thread.id }))?.activity).toBe("running");
    await call("approvals.resolve", { runId: worker.spec.runId, approvalId: "worker-approval", decision: "allow" });
    await expect(answer).resolves.toMatchObject({ decision: "allow" });
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))?.executions[0]!.activity).toBe("working");
    expect((await call("threads.get", { id: started.thread.id }))?.activity).toBe("running");
  });

  it("replays project-scoped team launches and rejects changed launch payloads without changing ordinary model semantics", async () => {
    await call("app.settings.set", { experimentalTeamExecution: true });
    const saved = orchestration.save(core.db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    const input = {
      projectId: project.id,
      requestKey: "launch-once",
      executionTarget: { kind: "team" as const, teamRevisionId: saved.revision.id },
      mode: "act" as const,
      permissionMode: "trusted" as const,
      prompt: "Start exactly one task",
    };
    const [first, replay] = await Promise.all([call("threads.start", input), call("threads.start", input)]);
    expect(replay.thread.id).toBe(first.thread.id);
    const runtime = (await call("orchestration.runtime", { threadId: first.thread.id }))!;
    const execution = runtime.executions[0]!;
    executions.push(execution.id);
    expect(threads.list(core.db)).toHaveLength(1);
    await expect(call("threads.start", { ...input, prompt: "Different task" })).rejects.toThrow(/request key.*different/);
    await expect(call("threads.start", { ...input, attachments: ["/different.png"] })).rejects.toThrow(/request key.*different/);
    await core.teams.drain();
    await finish(leadTurn(execution.id), execution.id, "completed");
    await call("app.settings.set", { experimentalTeamExecution: false });
    expect((await call("threads.start", input)).thread.id).toBe(first.thread.id);
    expect(threads.list(core.db)).toHaveLength(1);
    await expect(
      call("threads.start", { projectId: project.id, requestKey: "unsupported-model-key", agent: "codex", model: "fixture-codex", mode: "act", permissionMode: "trusted", prompt: "Ordinary request" }),
    ).rejects.toThrow(/request keys apply only/);
  });

  it("replays historical active steering after termination and rechecks configuration version after asynchronous validation", async () => {
    const started = await startPublic();
    const direction = { threadId: started.thread.id, text: "A durable direction", requestKey: "direction-once" };
    await call("orchestration.send", direction);
    await call("orchestration.stop", { threadId: started.thread.id, executionId: started.execution.id });
    const replay = await call("orchestration.send", direction);
    expect(replay.executions).toHaveLength(1);
    expect(replay.executions[0]!.userDirections).toHaveLength(1);
    await expect(call("orchestration.send", { ...direction, text: "Different direction" })).rejects.toThrow(/different direction/);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let validating!: () => void;
    const entered = new Promise<void>((resolve) => {
      validating = resolve;
    });
    vi.mocked(core.orchestration.preflight).mockImplementationOnce(async () => {
      validating();
      await gate;
      return { ready: true, issues: [] };
    });
    const pending = call("orchestration.send", { threadId: started.thread.id, text: "Validated against stale settings", requestKey: "racing-config" });
    const rejected = expect(pending).rejects.toThrow(/configuration changed/);
    await entered;
    // Returning to identical settings still changes the observed configuration version.
    await call("orchestration.configureLead", { threadId: started.thread.id, leadOverrides: { effort: "medium" } });
    await call("orchestration.configureLead", { threadId: started.thread.id, leadOverrides: {} });
    release();
    await rejected;
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))?.executions).toHaveLength(1);
  });

  it("starts independent public team instances with immutable overrides and preserves completed execution history on follow-up", async () => {
    const first = await startPublic(draft(), { effort: "medium" });
    const turn = leadTurn(first.execution.id);
    expect(turn.spec.effort).toBe("medium");
    expect(first.runtime.instance.leadOverrides).toEqual({ effort: "medium" });
    expect(first.saved.revision.members[0]!.settings.effort).toBe("high");
    expect(await call("threads.get", { id: first.thread.id })).toMatchObject({ teamInstanceId: first.runtime.instance.id, activity: "running", workspaceMode: "worktree" });
    const pendingSettings = await call("orchestration.configureLead", { threadId: first.thread.id, leadOverrides: { effort: "high" } });
    expect(pendingSettings.instance.configurationVersion).toBe(2);
    expect(turn.spec.effort).toBe("medium");
    await finish(turn, first.execution.id, "completed");
    const configured = await call("orchestration.configureLead", { threadId: first.thread.id, leadOverrides: { effort: "high" } });
    expect(configured.instance).toMatchObject({ configurationVersion: 2, leadOverrides: { effort: "high" } });
    const attachment = path.join(directory, "follow-up.png");
    await writeFile(attachment, Buffer.from([137, 80, 78, 71]));
    const next = await call("orchestration.send", { threadId: first.thread.id, text: "A second independent goal", attachments: [attachment], requestKey: "second-goal" });
    const second = next.executions[1]!;
    executions.push(second.id);
    await core.teams.drain();
    expect(next.instance.id).toBe(first.runtime.instance.id);
    expect(next.executions).toHaveLength(2);
    expect(next.executions[0]).toMatchObject({ id: first.execution.id, state: "completed", initialPrompt: { text: "The user's original team request." } });
    expect(second.initialPrompt).toMatchObject({ text: "A second independent goal", attachments: [attachment] });
    expect(leadTurn(second.id).spec).toMatchObject({ effort: "high", attachments: [attachment] });
    expect(core.teams.status(first.execution.id).attempts[0]!.settings.effort).toBe("medium");
    const other = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: first.saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Separate task using the same saved revision",
    });
    const separate = (await call("orchestration.runtime", { threadId: other.thread.id }))!;
    executions.push(separate.executions[0]!.id);
    expect(separate.instance.id).not.toBe(next.instance.id);
    expect(separate.instance.members[0]!.id).not.toBe(next.instance.members[0]!.id);
    expect(separate.instance.leadOverrides).toEqual({});
  });

  it("rejects a selected base for a local start before admission or checkout changes", async () => {
    await call("app.settings.set", { experimentalTeamExecution: true });
    const saved = orchestration.save(core.db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    await expect(
      call("threads.start", {
        projectId: project.id,
        executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
        mode: "act",
        permissionMode: "trusted",
        workspaceMode: "current",
        baseRef: "main",
        prompt: "Start locally",
      }),
    ).rejects.toThrow(/Local checkout uses the branch and files already checked out/);
    expect(threads.list(core.db)).toEqual([]);
    expect(scripted.size).toBe(0);
  });

  it("rejects excessive hierarchy, an unknown base and unavailable capabilities before creating any team task", async () => {
    await call("app.settings.set", { experimentalTeamExecution: true });
    const nested = draft("codex", true);
    nested.members.push({ key: "nested", name: "Nested worker", responsibility: "Implement", managerKey: "worker", settings: nested.members[0]!.settings });
    nested.members.push({ key: "too-deep", name: "Excessive depth", responsibility: "Implement", managerKey: "nested", settings: nested.members[0]!.settings });
    await expect(call("orchestration.save", { projectId: project.id, expectedRevisionId: null, draft: nested })).rejects.toThrow(/at most 3 levels/);
    const base = { projectId: project.id, mode: "act" as const, permissionMode: "trusted" as const, prompt: "Start the team" };
    const saved = orchestration.save(core.db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    const selected = { ...base, executionTarget: { kind: "team" as const, teamRevisionId: saved.revision.id } };
    await expect(call("threads.start", { ...selected, baseRef: "another-branch" })).rejects.toThrow(/was not found in the project repository/);
    vi.mocked(core.orchestration.preflight).mockResolvedValue({ ready: false, issues: [{ memberKey: "member", code: "model_unavailable", message: "Saved model unavailable" }] });
    await expect(call("threads.start", selected)).rejects.toThrow("Saved model unavailable");
    expect(threads.list(core.db)).toEqual([]);
    expect(scripted.size).toBe(0);
    expect(core.db.stmt("SELECT COUNT(*) AS n FROM orchestration_team_instances").get()).toMatchObject({ n: 0 });
  });

  it("keeps failed setup visible, blocks futile retry and permits status and Stop after disabling admission", async () => {
    projects.updateSettings(core.db, project.id, { setupScript: "exit 7" });
    const started = await startPublic();
    const runtime = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
    expect(runtime.executions[0]).toMatchObject({
      state: "attention",
      initialPrompt: { text: "The user's original team request." },
      actors: [{ retry: { allowed: false }, workspace: { state: "attention", setupState: "blocked" } }],
    });
    await expect(call("orchestration.retry", { threadId: started.thread.id, executionId: started.execution.id, actorId: "lead" })).rejects.toThrow(/setup exited/);
    await call("app.settings.set", { experimentalTeamExecution: false });
    expect(await call("orchestration.availability", {})).toMatchObject({ enabled: false, maxHierarchyDepth: 3 });
    const stopped = await call("orchestration.stop", { threadId: started.thread.id, executionId: started.execution.id });
    expect(stopped.executions[0]!.state).toBe("stopped");
    await expect(call("orchestration.send", { threadId: started.thread.id, text: "Try new work", requestKey: "disabled" })).rejects.toThrow(/disabled/);
    expect(scripted.size).toBe(0);
  });

  it("checks UI control ownership and deduplicates active direction including its images", async () => {
    const first = await startPublic();
    const second = await startPublic();
    await expect(call("orchestration.stop", { threadId: second.thread.id, executionId: first.execution.id })).rejects.toThrow(/another task/);
    const input = { threadId: first.thread.id, text: "Keep the original behavior", attachments: ["/managed/reference.png", "/managed/reference.png"], requestKey: "steer-once" };
    await call("orchestration.send", input);
    const repeated = await call("orchestration.send", input);
    expect(repeated.executions[0]!.userDirections.map((item) => item.text)).toEqual([input.text]);
    expect(repeated.executions[0]!.userDirections[0]).toMatchObject({ attachments: [input.attachments[0]], state: "pending" });
    await expect(call("orchestration.send", { ...input, attachments: ["/different.png"] })).rejects.toThrow(/different direction/);
    await expect(call("orchestration.send", { ...input, now: true })).rejects.toThrow(/different direction/);
    expect(JSON.stringify(repeated)).not.toContain("TEAM EXECUTION");
    expect(repeated.executions[0]).not.toHaveProperty("messages");
  });

  it("delivers explicit live direction once through RPC and retains its completed receipt on replay", async () => {
    liveSteering = true;
    const started = await startPublic();
    const first = leadTurn(started.execution.id);
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))?.steer).toEqual({ allowed: true, reason: null });
    const input = { threadId: started.thread.id, text: "Apply this correction in the current turn", attachments: ["/managed/live-reference.png"], requestKey: "live-rpc-once", now: true };
    await Promise.all([call("orchestration.send", input), call("orchestration.send", input)]);
    await core.teams.drain();
    expect(liveDelivery).toHaveBeenCalledExactlyOnceWith(input.text, input.attachments);
    let runtime = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
    const direction = runtime.executions[0]!.userDirections[0]!;
    expect(direction).toMatchObject({ text: input.text, attachments: input.attachments, state: "claimed", live: { runId: first.spec.runId, state: "accepted" }, cancel: { allowed: false } });
    expect(scripted.size).toBe(1);
    await expect(call("orchestration.send", { ...input, now: false })).rejects.toThrow(/different direction/);
    await expect(call("orchestration.send", { ...input, text: "Changed correction" })).rejects.toThrow(/different direction/);
    await expect(call("orchestration.cancelDirection", { threadId: input.threadId, executionId: started.execution.id, messageId: direction.id })).rejects.toThrow(/already reserved/);
    await finish(first, started.execution.id, "completed");
    runtime = await call("orchestration.send", input);
    expect(runtime.executions).toHaveLength(1);
    expect(runtime.executions[0]!.userDirections).toHaveLength(1);
    expect(runtime.executions[0]!.userDirections[0]).toMatchObject({ id: direction.id, state: "delivered", live: { runId: first.spec.runId, state: "accepted" } });
    expect(liveDelivery).toHaveBeenCalledTimes(1);
    expect(scripted.size).toBe(1);
  });

  it.each(["codex"] as const)("preserves ordered %s input when a live correction follows queued direction", async (agent) => {
    liveSteering = true;
    const started = await startPublic(draft(agent));
    const threadId = started.thread.id;
    await call("orchestration.send", { threadId, text: "First queued instruction", requestKey: "queue-first" });
    const request = { threadId, text: "Later immediate instruction", requestKey: "live-second", now: true };
    const result = await call("orchestration.send", request);
    await core.teams.drain();
    // The mutation response can only report reservation; provider acknowledgment arrives later.
    expect(result.steer?.allowed).toBe(false);
    const current = (await call("orchestration.runtime", { threadId }))!;
    if (agent === "codex") {
      expect(result.executions[0]!.userDirections[0]).toMatchObject({ state: "claimed", live: { state: "reserved" } });
      expect(current.executions[0]!.userDirections.map((item) => [item.text, item.state, item.live?.state])).toEqual([
        ["First queued instruction", "claimed", "accepted"],
        [request.text, "claimed", "accepted"],
      ]);
      expect(liveDelivery).toHaveBeenNthCalledWith(1, "First queued instruction", []);
      expect(liveDelivery).toHaveBeenNthCalledWith(2, request.text, []);
    } else {
      expect(current.executions[0]!.userDirections.map((item) => ({ text: item.text, state: item.state, live: item.live }))).toEqual([
        { text: "First queued instruction", state: "pending", live: undefined },
        { text: request.text, state: "pending", live: undefined },
      ]);
      expect(liveDelivery).not.toHaveBeenCalled();
    }
    expect(scripted.size).toBe(1);
    const replay = await call("orchestration.send", request);
    expect(replay.executions[0]!.userDirections).toHaveLength(2);
    await expect(call("orchestration.send", { ...request, now: false })).rejects.toThrow(/different direction/);
  });

  it.each(["claude"] as const)("delivers queued images to the next %s lead turn and retains their receipt after completion", async (agent) => {
    const started = await startPublic(draft(agent));
    const first = leadTurn(started.execution.id);
    const input = { threadId: started.thread.id, text: "Use this revised design", attachments: [path.join(directory, "revised.png")], requestKey: "image-direction" };
    await writeFile(input.attachments[0]!, Buffer.from([137, 80, 78, 71]));
    await call("orchestration.send", input);
    expect(scripted.size).toBe(1);
    expect(first.spec.attachments ?? []).toEqual([]);
    emitFinish(first);
    await vi.waitFor(() => expect(core.teams.status(started.execution.id).attempts.filter((item) => item.runId)).toHaveLength(2), { timeout: 10_000 });
    await core.teams.drain();
    const next = leadTurn(started.execution.id);
    expect(next.spec).toMatchObject({ attachments: input.attachments, prompt: expect.stringContaining(input.text) });
    let runtime = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
    expect(runtime.executions[0]!.userDirections[0]).toMatchObject({ attachments: input.attachments, state: "claimed" });
    await call("orchestration.send", input);
    expect(core.teams.status(started.execution.id).messages).toHaveLength(1);
    await finish(next, started.execution.id, "completed");
    runtime = await call("orchestration.send", input);
    expect(runtime.executions).toHaveLength(1);
    expect(runtime.executions[0]!.userDirections[0]).toMatchObject({ attachments: input.attachments, state: "delivered" });
    expect(core.teams.status(started.execution.id).attempts.map((item) => item.attachments)).toEqual([[], input.attachments]);
  });

  it.each(["claude"] as const)("cancels unreserved %s direction through RPC without losing history or reviving it on replay", async (agent) => {
    const started = await startPublic(draft(agent));
    const first = leadTurn(started.execution.id);
    await mcpCall(first.spec.runId, "team_complete", { result: "Original work is complete" });
    const input = { threadId: started.thread.id, text: "CANCELLED_DIRECTION_SENTINEL", attachments: [path.join(directory, "cancelled.png")], requestKey: "cancel-once" };
    await writeFile(input.attachments[0]!, Buffer.from([137, 80, 78, 71]));
    const queued = await call("orchestration.send", input);
    const direction = queued.executions[0]!.userDirections[0]!;
    expect(direction).toMatchObject({ state: "pending", cancel: { allowed: true } });
    const request = { threadId: started.thread.id, executionId: started.execution.id, messageId: direction.id };
    const cancelled = await call("orchestration.cancelDirection", request);
    expect(cancelled.executions[0]!.userDirections[0]).toMatchObject({ id: direction.id, text: input.text, attachments: input.attachments, state: "cancelled", cancel: { allowed: false } });
    const retained = core.teams.status(started.execution.id);
    await call("orchestration.cancelDirection", request);
    await call("orchestration.send", input);
    expect(core.teams.status(started.execution.id)).toEqual(retained);
    expect(core.db.stmt("SELECT metadata FROM audit_events WHERE action = 'team.direction.cancel'").all()).toEqual([
      { metadata: JSON.stringify({ executionId: request.executionId, messageId: request.messageId }) },
    ]);
    await finish(first, started.execution.id, "completed");
    expect(core.teams.status(started.execution.id).attempts).toHaveLength(1);
    await call("orchestration.compact", { threadId: started.thread.id, requestKey: "compact-after-cancel" });
    const checkpoint = teamContexts.listForInstance(core.db, started.runtime.instance.id)[0]!;
    expect(JSON.stringify(checkpoint.seed)).not.toContain(input.text);
    expect(JSON.stringify(checkpoint.seed)).not.toContain(input.attachments[0]);
    const next = await call("orchestration.send", { threadId: started.thread.id, text: "Continue the original goal", requestKey: "after-cancellation" });
    executions.push(next.executions[1]!.id);
    await core.teams.drain();
    const nextTurn = leadTurn(next.executions[1]!.id);
    expect(nextTurn.spec.prompt).not.toContain(input.text);
    expect(nextTurn.spec.attachments ?? []).not.toContain(input.attachments[0]);
    expect((await call("orchestration.send", input)).executions[0]!.userDirections[0]!.state).toBe("cancelled");
    await finish(nextTurn, next.executions[1]!.id, "completed");
  });

  it("rejects cancellation of a claimed direction and another task's execution", async () => {
    const started = await startPublic();
    const input = { threadId: started.thread.id, text: "Already delivered to the provider", requestKey: "claimed-direction" };
    const queued = await call("orchestration.send", input);
    const messageId = queued.executions[0]!.userDirections[0]!.id;
    emitFinish(leadTurn(started.execution.id));
    await vi.waitFor(() => expect(core.teams.status(started.execution.id).attempts.filter((item) => item.runId)).toHaveLength(2), { timeout: 10_000 });
    await core.teams.drain();
    const before = core.teams.status(started.execution.id);
    await expect(call("orchestration.cancelDirection", { threadId: started.thread.id, executionId: started.execution.id, messageId })).rejects.toThrow(/reserved|delivered/i);
    const other = await startPublic();
    await expect(call("orchestration.cancelDirection", { threadId: other.thread.id, executionId: started.execution.id, messageId })).rejects.toThrow(/another task/);
    expect(core.teams.status(started.execution.id)).toEqual(before);
    await finish(leadTurn(started.execution.id), started.execution.id, "completed");
  });

  it("applies requested permissions to all team writers while retaining questions, native limits and other tasks", async () => {
    const team = draft("codex", true);
    team.members.push({ key: "reviewer", name: "Reviewer", managerKey: "lead", responsibility: "Review", settings: team.members[0]!.settings });
    const started = await startPublic(team);
    const lead = leadTurn(started.execution.id);
    const actorIds: string[] = [];
    for (const member of ["worker", "reviewer"]) {
      const delegated = await mcpCall(lead.spec.runId, "task_create", { title: member, spec: "Check assigned work", execution: "delegate", member_key: member, request_key: member });
      actorIds.push(core.teams.status(started.execution.id).actors.find((actor) => actor.taskId === delegated.task.id)!.id);
    }
    await mcpCall(lead.spec.runId, "team_wait", { assignment_ids: actorIds });
    await finish(lead, started.execution.id, "waiting");
    const writers = actorIds.map((id) => actorTurn(started.execution.id, id));
    const other = await startPublic();
    const otherRunId = leadTurn(other.execution.id).spec.runId;
    const approvals = writers.map((turn) => core.runs.requestApproval(turn.spec.runId, "shared-id", "Bash", { command: "fixture" }));
    const question = core.runs.requestApproval(writers[0]!.spec.runId, "question-id", "AskUserQuestion", { questions: [{ question: "Which direction?" }] });
    const unrelated = core.runs.requestApproval(otherRunId, "shared-id", "Bash", { command: "fixture" });
    await call("threads.update", { id: started.thread.id, patch: { permissionMode: "autonomous" } });
    for (const approval of approvals) await expect(approval).resolves.toMatchObject({ decision: "allow" });
    let policy = (await call("orchestration.runtime", { threadId: started.thread.id }))!.policy!;
    expect(policy).toMatchObject({ requested: "autonomous", effective: "autonomous", pendingRestart: false });
    expect(policy.runs.map((run) => run.runId).sort()).toEqual(writers.map((turn) => turn.spec.runId).sort());
    expect(core.runs.pending().map((item) => [item.runId, item.approvalId])).toEqual(
      expect.arrayContaining([
        [writers[0]!.spec.runId, "question-id"],
        [otherRunId, "shared-id"],
      ]),
    );
    await call("threads.update", { id: started.thread.id, patch: { permissionMode: "review" } });
    policy = (await call("orchestration.runtime", { threadId: started.thread.id }))!.policy!;
    expect(policy).toMatchObject({ requested: "review", effective: "trusted", pendingRestart: true });
    expect(policy.runs.every((run) => run.providerPermissionMode === "trusted" && run.pendingRestart)).toBe(true);
    const tightened = core.runs.requestApproval(writers[1]!.spec.runId, "after-tightening", "Bash", { command: "fixture" });
    expect(core.runs.pending().some((item) => item.approvalId === "after-tightening")).toBe(true);
    await call("threads.update", { id: started.thread.id, patch: { mode: "plan", permissionMode: "autonomous" } });
    expect(threads.get(core.db, started.thread.id)).toMatchObject({ mode: "plan", permissionMode: "autonomous" });
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.policy).toMatchObject({
      mode: { requested: "plan", effective: "act", pending: true },
      effective: "trusted",
      pendingRestart: true,
    });
    expect(core.runs.pending().some((item) => item.approvalId === "after-tightening")).toBe(true);
    await call("threads.update", { id: started.thread.id, patch: { mode: "act" } });
    await expect(tightened).resolves.toMatchObject({ decision: "allow" });
    expect(core.runs.pending()).toHaveLength(2);
    expect((await call("orchestration.runtime", { threadId: other.thread.id }))!.policy).toMatchObject({ requested: "trusted", effective: "trusted" });
    await call("approvals.resolve", { runId: writers[0]!.spec.runId, approvalId: "question-id", decision: "allow", answers: { "Which direction?": ["Continue"] } });
    await expect(question).resolves.toMatchObject({ decision: "allow" });
    await call("approvals.resolve", { runId: otherRunId, approvalId: "shared-id", decision: "deny" });
    await expect(unrelated).resolves.toMatchObject({ decision: "deny" });
    await call("orchestration.stop", { threadId: started.thread.id, executionId: started.execution.id });
    await call("threads.update", { id: started.thread.id, patch: { permissionMode: "review" } });
    const next = await call("orchestration.send", { threadId: started.thread.id, text: "Use the latest permissions", requestKey: "restart-review" });
    const executionId = next.executions[1]!.id;
    executions.push(executionId);
    await core.teams.drain();
    expect(leadTurn(executionId).spec.permissionMode).toBe("review");
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.policy).toMatchObject({ requested: "review", effective: "review", pendingRestart: false });
    await finish(leadTurn(executionId), executionId, "completed");
  });

  it("projects held implementation as waiting while Plan discussions preserve the assignment and its task", async () => {
    const started = await startPublic(draft("codex", true));
    const lead = leadTurn(started.execution.id);
    const delegated = await mcpCall(lead.spec.runId, "task_create", {
      title: "Retain this assignment",
      spec: "Keep the accepted implementation input",
      execution: "delegate",
      member_key: "worker",
      request_key: "held-worker",
    });
    const worker = core.teams.status(started.execution.id).actors.find((actor) => actor.taskId === delegated.task.id)!;
    await call("threads.update", { id: started.thread.id, patch: { mode: "plan" } });
    await mcpCall(lead.spec.runId, "team_wait", { assignment_ids: [worker.id] });
    await finish(lead, started.execution.id, "waiting");
    const held = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
    expect(held.executions[0]).toMatchObject({ state: "active", activity: "waiting" });
    expect(held.executions[0]!.actors.find((actor) => actor.id === worker.id)).toMatchObject({ state: "queued", modeHold: "plan", runIds: [], taskId: delegated.task.id });
    expect((await call("threads.get", { id: started.thread.id }))!.activity).toBe("waiting");
    await call("orchestration.send", { threadId: started.thread.id, text: "Explain the retained assignment", requestKey: "held-discussion" });
    await core.teams.drain();
    const plan = leadTurn(started.execution.id);
    expect(runs.get(core.db, plan.spec.runId)?.mode).toBe("plan");
    await finish(plan, started.execution.id, "waiting");
    const discussed = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
    expect(discussed.executions[0]).toMatchObject({ state: "active", activity: "waiting" });
    expect(discussed.executions[0]!.actors.find((actor) => actor.id === "lead")).toMatchObject({ state: "waiting", modeHold: "plan" });
    expect(core.teams.status(started.execution.id).actors.find((actor) => actor.id === worker.id)!.input).toEqual(worker.input);
    expect(tasks.get(core.db, delegated.task.id)!.status).toBe(delegated.task.status);
    expect(scripted.size).toBe(2);
    await call("orchestration.stop", { threadId: started.thread.id, executionId: started.execution.id });
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.executions[0]!.actors.every((actor) => actor.modeHold === undefined)).toBe(true);
    const count = scripted.size;
    await call("threads.update", { id: started.thread.id, patch: { mode: "act" } });
    await core.teams.drain();
    expect(scripted.size).toBe(count);
    expect(core.teams.status(started.execution.id).state).toBe("stopped");
  });

  it.each(["codex"] as const)("changes %s mode on the next turn while retaining directions and actual provider policy", async (agent) => {
    liveSteering = true;
    const started = await startPublic(draft(agent, true));
    const act = leadTurn(started.execution.id);
    const original = core.teams.status(started.execution.id);
    await call("threads.update", { id: started.thread.id, patch: { mode: "plan", permissionMode: "autonomous" } });
    const pending = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
    expect(pending.policy).toMatchObject({ mode: { requested: "plan", effective: "act", pending: true }, effective: "trusted" });
    expect(pending.steer?.allowed).toBe(false);
    expect(core.teams.status(started.execution.id).generation).toBe(original.generation);
    expect(act.exited).toBe(false);
    expect(runs.get(core.db, act.spec.runId)?.mode).toBe("act");
    const proposal = await mcpCall(act.spec.runId, "task_create", {
      title: "Keep this for later",
      spec: "Do not launch while Plan is requested",
      execution: "delegate",
      member_key: "worker",
      request_key: "plan-proposal",
    });
    expect(proposal).toMatchObject({ started: false, task: { status: "proposed" } });
    expect(core.teams.status(started.execution.id).actors.filter((item) => !item.participant)).toHaveLength(1);
    const planDirection = { threadId: started.thread.id, text: "Discuss the retained proposal before implementation", requestKey: "requested-plan-direction", now: true };
    await call("orchestration.send", planDirection);
    expect(liveDelivery).not.toHaveBeenCalled();
    emitFinish(act);
    await vi.waitFor(() => expect(core.teams.status(started.execution.id).attempts.filter((attempt) => attempt.runId)).toHaveLength(2), { timeout: 10_000 });
    await core.teams.drain();
    const plan = leadTurn(started.execution.id);
    expect(plan.spec.permissionMode).toBe("review");
    expect(plan.spec.prompt).toContain(planDirection.text);
    expect(runs.get(core.db, plan.spec.runId)?.mode).toBe("plan");
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.policy!.mode).toEqual({ requested: "plan", effective: "plan", pending: false });
    await call("threads.update", { id: started.thread.id, patch: { mode: "act" } });
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.policy!.mode).toEqual({ requested: "act", effective: "plan", pending: true });
    await expect(mcpCall(plan.spec.runId, "task_start", { id: proposal.task.id, member_key: "worker", request_key: "stale-plan-start" })).rejects.toThrow(/Plan|Act/i);
    const actDirection = { threadId: started.thread.id, text: "Continue with this clarified implementation request", requestKey: "requested-act-direction", now: true };
    await call("orchestration.send", actDirection);
    expect(liveDelivery).not.toHaveBeenCalled();
    emitFinish(plan);
    await vi.waitFor(() => expect(core.teams.status(started.execution.id).attempts.filter((attempt) => attempt.runId)).toHaveLength(3), { timeout: 10_000 });
    await core.teams.drain();
    const next = leadTurn(started.execution.id);
    expect(next.spec.permissionMode).toBe("autonomous");
    expect(next.spec.prompt).toContain(actDirection.text);
    expect(runs.get(core.db, next.spec.runId)?.mode).toBe("act");
    expect(core.teams.status(started.execution.id).generation).toBe(original.generation);
    await finish(next, started.execution.id, "completed");
    const final = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
    expect(final.executions[0]!.userDirections).toEqual([
      expect.objectContaining({ text: planDirection.text, state: "delivered" }),
      expect.objectContaining({ text: actDirection.text, state: "delivered" }),
    ]);
    expect(final.policy!.mode).toEqual({ requested: "act", effective: "act", pending: false });
    expect(scripted.size).toBe(3);
  });

  it.each(["codex", "claude"] as const)("adopts the latest %s permission policy when the next turn is awaiting MCP startup", async (agent) => {
    const started = await startPublic(draft(agent));
    await finish(leadTurn(started.execution.id), started.execution.id, "completed");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = core.mcpServer.bind(core);
    const mcp = vi.spyOn(core, "mcpServer").mockImplementationOnce(async () => {
      entered();
      await gate;
      return server();
    });
    try {
      const next = await call("orchestration.send", { threadId: started.thread.id, text: "Use the final requested startup policy", requestKey: "startup-policy-race" });
      const execution = next.executions[1]!;
      executions.push(execution.id);
      await ready;
      await call("threads.update", { id: started.thread.id, patch: { permissionMode: "autonomous" } });
      release();
      await core.teams.drain();
      const turn = leadTurn(execution.id);
      expect(turn.spec.permissionMode).toBe("autonomous");
      expect(core.teams.status(execution.id)).toMatchObject({ state: "active", actors: [{ state: "running" }] });
      expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.policy).toMatchObject({ requested: "autonomous", effective: "autonomous", pendingRestart: false });
      await finish(turn, execution.id, "completed");
    } finally {
      release();
      mcp.mockRestore();
    }
  });

  it("rechecks archive during follow-up admission and wakes organized work only after an accepted execution", async () => {
    const started = await startPublic();
    await finish(leadTurn(started.execution.id), started.execution.id, "completed");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let validating!: () => void;
    const entered = new Promise<void>((resolve) => {
      validating = resolve;
    });
    vi.mocked(core.orchestration.preflight).mockImplementationOnce(async () => {
      validating();
      await gate;
      return { ready: true, issues: [] };
    });
    const pending = call("orchestration.send", { threadId: started.thread.id, text: "A racing follow-up", requestKey: "archive-race" });
    const rejected = expect(pending).rejects.toThrow(/archiv/i);
    await entered;
    await call("threads.update", { id: started.thread.id, patch: { archived: true } });
    release();
    await rejected;
    expect(scripted.size).toBe(1);
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.executions).toHaveLength(1);
    await expect(call("orchestration.send", { threadId: started.thread.id, text: "Still archived", requestKey: "archived" })).rejects.toThrow(/Unarchive/);
    await call("threads.update", { id: started.thread.id, patch: { archived: false, done: true, snoozedUntil: Date.now() + 60_000, mode: "plan", permissionMode: "review" } });
    const next = await call("orchestration.send", { threadId: started.thread.id, text: "Plan the next step", requestKey: "accepted-plan" });
    const execution = next.executions[1]!;
    executions.push(execution.id);
    await core.teams.drain();
    expect(threads.get(core.db, started.thread.id)).toMatchObject({ doneAt: null, snoozedUntil: null, archivedAt: null });
    expect(leadTurn(execution.id).spec).toMatchObject({ permissionMode: "review" });
    expect(runs.get(core.db, leadTurn(execution.id).spec.runId)?.mode).toBe("plan");
    await call("threads.update", { id: started.thread.id, patch: { mode: "act" } });
    expect((await call("orchestration.runtime", { threadId: started.thread.id }))!.policy!.mode).toEqual({ requested: "act", effective: "plan", pending: true });
    await finish(leadTurn(execution.id), execution.id, "completed");
    await call("threads.update", { id: started.thread.id, patch: { mode: "act", permissionMode: "autonomous" } });
    expect(threads.get(core.db, started.thread.id)).toMatchObject({ mode: "act", permissionMode: "autonomous" });
  });

  it.each(["claude"] as const)("compacts %s context without inference, then resumes only the new session across executions", async (agent) => {
    const started = await startPublic(draft(agent));
    const original = leadTurn(started.execution.id);
    const input = { threadId: started.thread.id, requestKey: "compact-once" };
    expect((await call("orchestration.runtime", { threadId: input.threadId }))?.context?.compact.allowed).toBe(false);
    await expect(call("orchestration.compact", input)).rejects.toThrow(/finish|stop|unfinished/i);
    expect(teamContexts.listForInstance(core.db, started.runtime.instance.id)).toEqual([]);
    original.handle.emit("event", { type: "thinking.completed", runId: original.spec.runId, ts: Date.now(), messageId: "private-reasoning", text: "HIDDEN_REASONING_MUST_NOT_ENTER_CONTEXT" });
    await finish(original, started.execution.id, "completed");
    const before = structuredClone(core.teams.status(started.execution.id));
    const count = scripted.size;
    const compacted = await call("orchestration.compact", input);
    expect(compacted.context?.checkpoints).toEqual([expect.objectContaining({ actorId: "lead", executionId: null, reason: "compact" })]);
    expect(compacted.context?.compact.allowed).toBe(true);
    expect(scripted.size).toBe(count);
    expect(core.teams.status(started.execution.id)).toEqual(before);
    const checkpoint = teamContexts.listForInstance(core.db, compacted.instance.id)[0]!;
    expect(checkpoint.seed).toContain("The user's original team request.");
    expect(checkpoint.seed).not.toContain("HIDDEN_REASONING_MUST_NOT_ENTER_CONTEXT");
    expect(JSON.stringify(compacted)).not.toContain('"seed"');
    expect((await call("orchestration.compact", input)).context?.checkpoints).toEqual(compacted.context?.checkpoints);
    const followup = await call("orchestration.send", { threadId: input.threadId, text: "Continue from the compacted context", requestKey: "after-compact" });
    const next = followup.executions.at(-1)!;
    executions.push(next.id);
    await core.teams.drain();
    const fresh = leadTurn(next.id);
    expect(fresh.spec.resumeSessionId).toBeUndefined();
    const reserved = core.teams.status(next.id).attempts[0]!;
    expect(reserved.contextSeed).toContain("The user's original team request.");
    expect(fresh.spec.systemPromptAppendix).toContain(reserved.contextSeed!);
    expect(reserved.contextCheckpointId).toBe(checkpoint.id);
    expect((await call("orchestration.compact", input)).context?.checkpoints).toHaveLength(1);
    await finish(fresh, next.id, "completed");
    const third = await call("orchestration.send", { threadId: input.threadId, text: "Continue the new session", requestKey: "resume-compacted" });
    const thirdExecution = third.executions.at(-1)!;
    executions.push(thirdExecution.id);
    await core.teams.drain();
    expect(leadTurn(thirdExecution.id).spec.resumeSessionId).toBe(`session-${fresh.spec.runId}`);
    expect(leadTurn(thirdExecution.id).spec.resumeSessionId).not.toBe(`session-${original.spec.runId}`);
    await finish(leadTurn(thirdExecution.id), thirdExecution.id, "completed");
  });

  it.each(["codex", "claude"] as const)("keeps %s fresh retry durable when its first startup also fails", async (agent) => {
    const team = draft(agent);
    team.limits.maxAttemptsPerAssignment = 3;
    const started = await startPublic(team);
    const original = leadTurn(started.execution.id);
    await finish(original, started.execution.id, "completed");
    const adapter = vi.mocked(agent === "codex" ? CodexAdapter.prototype.start : ClaudeAdapter.prototype.start);
    adapter.mockImplementationOnce((spec) => {
      expect(spec.resumeSessionId).toBe(`session-${original.spec.runId}`);
      throw new Error("The provider session was not found");
    });
    const next = await call("orchestration.send", { threadId: started.thread.id, text: "Recover this instruction without losing earlier context", requestKey: "lost-session" });
    const execution = next.executions.at(-1)!;
    executions.push(execution.id);
    await core.teams.drain();
    const input = { threadId: started.thread.id, executionId: execution.id, actorId: "lead", fresh: true, requestKey: "fresh-once" };
    expect((await call("orchestration.runtime", { threadId: input.threadId }))?.executions.at(-1)?.actors[0]?.freshRetry?.allowed).toBe(true);
    await expect(call("orchestration.retry", { ...input, requestKey: undefined })).rejects.toThrow(/request key/i);
    adapter.mockImplementationOnce((spec) => {
      expect(spec.resumeSessionId).toBeUndefined();
      expect(spec.systemPromptAppendix).toContain("The user's original team request.");
      throw new Error("Fresh provider startup failed before session.started");
    });
    await call("orchestration.retry", input);
    await core.teams.drain();
    const failed = core.teams.status(execution.id);
    expect(failed.actors[0]?.state).toBe("attention");
    expect(failed.attempts).toHaveLength(2);
    const checkpointId = failed.attempts[1]!.contextCheckpointId;
    expect(checkpointId).toEqual(expect.any(String));
    await call("orchestration.retry", input);
    expect(core.teams.status(execution.id)).toEqual(failed);
    await call("orchestration.retry", { threadId: input.threadId, executionId: execution.id, actorId: "lead" });
    await core.teams.drain();
    const recovered = leadTurn(execution.id);
    expect(recovered.spec.resumeSessionId).toBeUndefined();
    expect(core.teams.status(execution.id).attempts[2]!.contextCheckpointId).toBe(checkpointId);
    expect(recovered.spec.prompt).toContain("Recover this instruction");
    await finish(recovered, execution.id, "completed");
    expect((await call("orchestration.retry", input)).context?.checkpoints).toEqual([expect.objectContaining({ id: checkpointId, reason: "fresh_retry", executionId: execution.id })]);
    await expect(call("orchestration.retry", { ...input, executionId: started.execution.id })).rejects.toThrow(/different|origin|request/i);
    await expect(call("orchestration.compact", { threadId: input.threadId, requestKey: input.requestKey })).rejects.toThrow(/different|request/i);
    expect(teamContexts.listForInstance(core.db, started.runtime.instance.id)).toHaveLength(1);
  });

  it("routes the existing compact action through team barriers and preserves archived tasks", async () => {
    const started = await startPublic();
    await finish(leadTurn(started.execution.id), started.execution.id, "completed");
    await expect(call("threads.compact", { id: started.thread.id })).rejects.toThrow(/durable request key/);
    expect(teamContexts.listForInstance(core.db, started.runtime.instance.id)).toEqual([]);
    await call("threads.update", { id: started.thread.id, patch: { archived: true } });
    await expect(call("threads.compact", { id: started.thread.id, requestKey: "existing-command" })).rejects.toThrow(/Unarchive/);
    expect(teamContexts.listForInstance(core.db, started.runtime.instance.id)).toEqual([]);
    await call("threads.update", { id: started.thread.id, patch: { archived: false } });
    const stopped = vi.spyOn(core.teamWorkspaces, "assertStopped").mockImplementationOnce(() => {
      throw new Error("Integration is still closing");
    });
    await expect(call("threads.compact", { id: started.thread.id, requestKey: "existing-command" })).rejects.toThrow(/still closing/);
    expect(teamContexts.listForInstance(core.db, started.runtime.instance.id)).toEqual([]);
    stopped.mockRestore();
    await call("threads.compact", { id: started.thread.id, requestKey: "existing-command" });
    await call("threads.compact", { id: started.thread.id, requestKey: "existing-command" });
    expect(teamContexts.listForInstance(core.db, started.runtime.instance.id)).toHaveLength(1);
    expect(scripted.size).toBe(1);
  });

  it("freshly recovers a manager with its accepted child files and publication receipt intact", async () => {
    const team = draft();
    team.members.push(
      { key: "manager", name: "Manager", managerKey: "lead", responsibility: "Coordinate the worker", settings: { agent: "claude", model: "fixture-claude", effort: "high", fastMode: false } },
      { key: "worker", name: "Worker", managerKey: "manager", responsibility: "Implement the result", settings: { agent: "codex", model: "fixture-codex", effort: "medium", fastMode: false } },
    );
    const started = await startPublic(team);
    const lead = leadTurn(started.execution.id);
    const delegated = await mcpCall(lead.spec.runId, "task_create", {
      title: "Manager owns this output",
      spec: "Delegate and inspect the worker's retained file.",
      execution: "delegate",
      member_key: "manager",
      request_key: "manager",
    });
    const managerId = core.teams.status(started.execution.id).actors.find((actor) => actor.taskId === delegated.task.id)!.id;
    await mcpCall(lead.spec.runId, "team_wait", { assignment_ids: [managerId] });
    await finish(lead, started.execution.id, "waiting");
    const manager = actorTurn(started.execution.id, managerId);
    const assignment = { title: "Keep this accepted file", spec: "Write the requested proof file.", execution: "delegate", member_key: "worker", request_key: "worker" };
    const child = await mcpCall(manager.spec.runId, "task_create", assignment);
    const workerId = core.teams.status(started.execution.id).actors.find((actor) => actor.taskId === child.task.id)!.id;
    await mcpCall(manager.spec.runId, "team_wait", { assignment_ids: [workerId] });
    await finish(manager, started.execution.id, "waiting", managerId);
    const worker = actorTurn(started.execution.id, workerId);
    await writeFile(path.join(worker.spec.cwd, "recovery-proof.txt"), "Exactly one accepted child result\n");
    await mcpCall(worker.spec.runId, "team_complete", { result: "The proof file is ready." });
    await finish(worker, started.execution.id, "completed", workerId);
    const failed = actorTurn(started.execution.id, managerId);
    expect(await readFile(path.join(failed.spec.cwd, "recovery-proof.txt"), "utf8")).toContain("Exactly one");
    const receipts = teamWorkspaces.publications(core.db, started.execution.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ sourceActorId: workerId, targetActorId: managerId, state: "applied" });
    failed.handle.emit("event", { type: "session.started", runId: failed.spec.runId, ts: Date.now(), agent: "claude", model: "fixture-claude", externalSessionId: "lost-manager-session" });
    failed.handle.emit("event", { type: "error", runId: failed.spec.runId, ts: Date.now(), fatal: true, message: "The manager session was lost" });
    failed.handle.emit("event", { type: "turn.completed", runId: failed.spec.runId, ts: Date.now(), turnId: "failed-manager", status: "error", durationMs: 1 });
    await vi.waitFor(() => expect(core.teams.status(started.execution.id).actors.find((actor) => actor.id === managerId)?.state).toBe("attention"));
    await core.teams.drain();
    const attentionLead = leadTurn(started.execution.id);
    await mcpCall(attentionLead.spec.runId, "team_wait", { assignment_ids: [managerId] });
    await finish(attentionLead, started.execution.id, "waiting");
    await call("orchestration.retry", { threadId: started.thread.id, executionId: started.execution.id, actorId: managerId, fresh: true, requestKey: "fresh-manager" });
    await core.teams.drain();
    const recovered = actorTurn(started.execution.id, managerId);
    expect(recovered.spec.resumeSessionId).toBeUndefined();
    expect(recovered.spec.cwd).toBe(failed.spec.cwd);
    expect(await readFile(path.join(recovered.spec.cwd, "recovery-proof.txt"), "utf8")).toBe("Exactly one accepted child result\n");
    expect(recovered.spec.systemPromptAppendix).toContain(receipts[0]!.id);
    expect(teamWorkspaces.publications(core.db, started.execution.id)).toEqual(receipts);
    expect((await mcpCall(recovered.spec.runId, "task_create", assignment)).task.id).toBe(child.task.id);
    expect(tasks.list(core.db, { threadId: started.thread.id })).toHaveLength(2);
    await mcpCall(recovered.spec.runId, "team_complete", { result: "Manager verified the retained child result." });
    await finish(recovered, started.execution.id, "completed", managerId);
    const resumedLead = leadTurn(started.execution.id);
    expect(await readFile(path.join(resumedLead.spec.cwd, "recovery-proof.txt"), "utf8")).toBe("Exactly one accepted child result\n");
    const published = teamWorkspaces.publications(core.db, started.execution.id);
    expect(published).toHaveLength(2);
    expect(published.find((receipt) => receipt.sourceActorId === workerId)).toEqual(receipts[0]);
    await mcpCall(resumedLead.spec.runId, "team_complete", { result: "Integrated the recovered manager output once." });
    await finish(resumedLead, started.execution.id, "completed");
    await expect(readFile(path.join(root, "recovery-proof.txt"))).rejects.toThrow(/ENOENT/);
  });

  it("retains lossless output when a lead-only team completes without an explicit completion tool", async () => {
    const { execution, turn } = await startTeam();
    const result = Buffer.from([0, 255, 128, 13, 10, 1]);
    await writeFile(path.join(turn.spec.cwd, "implicit-result.bin"), result);
    await finish(turn, execution.id, "completed");
    expect(core.teams.status(execution.id)).toMatchObject({ state: "completed", actors: [{ id: "lead", disposition: null, result: "Scripted response" }] });
    const retained = teamWorkspaces.get(core.db, execution.id, "lead");
    expect(retained?.outputTree).toEqual(expect.any(String));
    await git(turn.spec.cwd, ["gc", "--prune=now"]);
    const entry = (await teamTransfer.listTree(turn.spec.cwd, retained!.outputTree!)).find((item) => item.path === "implicit-result.bin");
    expect(entry).toBeDefined();
    expect(await teamTransfer.readBlob(turn.spec.cwd, entry!.oid)).toEqual(result);
    await expect(readFile(path.join(root, "implicit-result.bin"))).rejects.toThrow(/ENOENT/);
  });

  it.each(["codex", "claude"] as const)("routes %s status, wait and completion through bound runs and revokes finished tokens", async (agent) => {
    const { execution, thread, turn } = await startTeam(draft(agent));
    expect(core.teams.binding(turn.spec.runId)).toMatchObject({ executionId: execution.id, actorId: "lead" });
    expect(TeamExecutionRecord.parse(await mcpCall(turn.spec.runId, "team_status"))).toMatchObject({ id: execution.id, threadId: thread.id });
    expect(await mcpCall(turn.spec.runId, "team_wait")).toMatchObject({ waiting: true });
    await finish(turn, execution.id, "waiting");
    expect(turn.exited).toBe(true);
    await expect(mcpCall(turn.spec.runId, "team_status")).rejects.toThrow("HTTP 404: unknown run");
    await call("threads.send", { id: thread.id, text: "Continue with the requested result" });
    await core.teams.drain();
    const resumed = leadTurn(execution.id);
    expect(resumed.spec.runId).not.toBe(turn.spec.runId);
    expect(resumed.spec.prompt).toContain("Continue with the requested result");
    expect(await mcpCall(resumed.spec.runId, "team_complete", { result: "Validated routing and captured the result" })).toMatchObject({ recorded: true });
    await finish(resumed, execution.id, "completed");
    expect(core.teams.status(execution.id).state).toBe("completed");
    expect(checkpoints.listForThread(core.db, thread.id)).not.toHaveLength(0);
    expect(tasks.list(core.db)).toEqual([]);
    await expect(mcpCall(resumed.spec.runId, "team_complete", { result: "Old token" })).rejects.toThrow();
  });

  it("captures team backlog intent once without starting work and preserves later document edits on replay", async () => {
    const { execution, thread, turn } = await startTeam(draft("codex", true));
    const before = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
    const base = { title: "Capture a follow-up", spec: "Record the requested work for later implementation." };
    const backlog = await mcpCall(turn.spec.runId, "task_create", base);
    expect(backlog).toMatchObject({ started: false, task: { status: "backlog" } });
    expect(tasks.get(core.db, backlog.task.id)).toMatchObject({ threadId: thread.id, worktreePath: null });
    expect(runs.listForTask(core.db, backlog.task.id)).toEqual([]);
    for (const extra of [{ execution: "delegate" }, { execution: "delegate", member_key: "worker" }, { execution: "delegate", request_key: "missing-member" }])
      await expect(mcpCall(turn.spec.runId, "task_create", { ...base, ...extra })).rejects.toThrow(/member|request|backlog/i);
    expect((await mcpCall(turn.spec.runId, "task_create", base)).task.id).toBe(backlog.task.id);
    const input = { ...base, member_key: "worker", request_key: "backlog-target", dependency_task_ids: [backlog.task.id] };
    const targeted = await mcpCall(turn.spec.runId, "task_create", input);
    expect(teamTasks.intent(core.db, targeted.task.id)).toMatchObject({
      memberKey: "worker",
      managerKey: "lead",
      parentTaskId: null,
      dependencyTaskIds: [backlog.task.id],
      origin: { executionId: execution.id, actorId: "lead" },
    });
    await call("tasks.update", { id: targeted.task.id, patch: { title: "The user's revised task", spec: "Updated instructions and ![image](openorc-image://retained.png)" } });
    const replay = await mcpCall(turn.spec.runId, "task_create", input);
    expect(replay).toMatchObject({ duplicate: true, started: false, task: { id: targeted.task.id, title: "The user's revised task" } });
    expect(tasks.get(core.db, targeted.task.id)?.spec).toContain("Updated instructions");
    await expect(mcpCall(turn.spec.runId, "task_create", { ...input, spec: "A different capture under the old request key" })).rejects.toThrow(/request key.*different/);
    await expect(mcpCall(turn.spec.runId, "task_create", { ...input, member_key: "missing-member", request_key: "invalid-member" })).rejects.toThrow(/direct report|manager/i);
    expect(tasks.list(core.db)).toHaveLength(2);
    expect(teamTasks.intents(core.db, execution.instanceId)).toHaveLength(2);
    expect(core.teams.status(execution.id).actors.filter((item) => !item.participant)).toHaveLength(1);
    expect(scripted.size).toBe(1);
    expect((await git(root, ["worktree", "list", "--porcelain"])).stdout).toBe(before);
  });

  it.each(["claude"] as const)("captures %s Plan delegation as a proposal without reserving an actor or starting a provider", async (agent) => {
    const thread = newThread(agent);
    threads.update(core.db, thread.id, { mode: "plan" });
    const { execution, turn } = await startTeam(draft(agent, true), threads.get(core.db, thread.id)!);
    const before = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
    const input = {
      title: "Propose the requested implementation",
      spec: "Plan this change with its verification and acceptance criteria.",
      execution: "delegate",
      member_key: "worker",
      request_key: "plan-proposal",
    };
    const proposal = await mcpCall(turn.spec.runId, "task_create", input);
    expect(proposal).toMatchObject({ started: false, task: { status: "proposed" } });
    expect((await mcpCall(turn.spec.runId, "task_create", input)).task.id).toBe(proposal.task.id);
    expect(teamTasks.intent(core.db, proposal.task.id)?.memberKey).toBe("worker");
    await expect(mcpCall(turn.spec.runId, "task_start", { id: proposal.task.id })).rejects.toThrow();
    expect(core.teams.status(execution.id).actors.filter((item) => !item.participant)).toHaveLength(1);
    expect(runs.listForTask(core.db, proposal.task.id)).toEqual([]);
    expect(tasks.get(core.db, proposal.task.id)?.worktreePath).toBeNull();
    expect(scripted.size).toBe(1);
    expect((await git(root, ["worktree", "list", "--porcelain"])).stdout).toBe(before);
  });

  it("lets a leaf capture work for its manager while retaining task dependencies and the true originating actor", async () => {
    const { execution, turn } = await startTeam(draft("codex", true));
    const delegated = await mcpCall(turn.spec.runId, "task_create", {
      title: "Inspect the bounded change",
      spec: "Inspect this change and capture any later work.",
      execution: "delegate",
      member_key: "worker",
      request_key: "inspect",
    });
    const actor = core.teams.status(execution.id).actors.find((item) => item.taskId === delegated.task.id)!;
    await mcpCall(turn.spec.runId, "team_wait", { assignment_ids: [actor.id] });
    await finish(turn, execution.id, "waiting");
    const worker = actorTurn(execution.id, actor.id);
    const before = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
    const input = {
      title: "Follow up on the inspection",
      spec: "Retain this work for later implementation after the inspection.",
      member_key: "worker",
      request_key: "leaf-capture",
      dependency_task_ids: [delegated.task.id],
    };
    const captured = await mcpCall(worker.spec.runId, "task_create", input);
    expect(captured).toMatchObject({ started: false, task: { status: "backlog" } });
    expect(teamTasks.intent(core.db, captured.task.id)).toMatchObject({
      managerKey: "lead",
      memberKey: "worker",
      parentTaskId: null,
      dependencyTaskIds: [delegated.task.id],
      origin: { executionId: execution.id, actorId: actor.id },
    });
    expect(core.teams.status(execution.id).actors.filter((item) => !item.participant)).toHaveLength(2);
    expect(runs.listForTask(core.db, captured.task.id)).toEqual([]);
    expect(scripted.size).toBe(2);
    expect((await git(root, ["worktree", "list", "--porcelain"])).stdout).toBe(before);
  });

  it.each([
    ["codex", "claude"],
    ["codex", "opencode"],
    ["opencode", "claude"],
  ] as const)("reserves %s → %s delegation once, transfers dirty input and integrates the worker result", async (leadAgent, workerAgent) => {
    const teamDraft = draft(leadAgent, true);
    teamDraft.members[1]!.settings = draft(workerAgent).members[0]!.settings;
    const thread = newThread(leadAgent);
    if (leadAgent === "opencode" || workerAgent === "opencode") threads.update(core.db, thread.id, { permissionMode: "autonomous" });
    const { execution, turn } = await startTeam(teamDraft, threads.get(core.db, thread.id)!);
    const input = {
      title: "Implement the bounded assignment",
      spec: "Implement the requested change and verify the regression.",
      execution: "delegate",
      member_key: "worker",
      request_key: "worker-implementation",
    };
    const first = await mcpCall(turn.spec.runId, "task_create", input);
    const repeated = await mcpCall(turn.spec.runId, "task_create", input);
    expect(first).toMatchObject({ started: false, duplicate: false });
    expect(repeated).toMatchObject({ started: false, duplicate: true, task: { id: first.task.id } });
    await core.teams.drain();
    const actor = core.teams.status(execution.id).actors.find((candidate) => candidate.taskId === first.task.id);
    expect(actor).toMatchObject({ memberKey: "worker", state: "queued" });
    expect(tasks.get(core.db, first.task.id)?.worktreePath).toBeNull();
    expect(runs.listForTask(core.db, first.task.id)).toEqual([]);
    expect(scripted.size).toBe(1);
    expect(await mcpCall(turn.spec.runId, "team_message", { recipient_id: actor!.id, text: "Retain this direction for a later explicit retry", request_key: "follow-up" })).toMatchObject({
      recipientId: actor!.id,
      kind: "direction",
    });
    await mcpCall(turn.spec.runId, "task_update", { id: first.task.id, status: "done" });
    expect(tasks.get(core.db, first.task.id)?.status).toBe("done");
    await writeFile(path.join(turn.spec.cwd, "lead-input.txt"), "Uncommitted lead input\n");
    await mcpCall(turn.spec.runId, "team_wait", { assignment_ids: [actor!.id] });
    await finish(turn, execution.id, "waiting");
    const attempt = core.teams.status(execution.id).attempts.find((item) => item.actorId === actor!.id)!;
    const worker = scripted.get(attempt.runId!)!;
    expect(worker.spec.agent).toBe(workerAgent);
    expect(worker.spec.model).toBe(teamDraft.members[1]!.settings.model);
    expect(await readFile(path.join(worker.spec.cwd, "lead-input.txt"), "utf8")).toBe("Uncommitted lead input\n");
    // A non-lead agent can move its task too, without cancelling its live work.
    await mcpCall(worker.spec.runId, "task_update", { id: first.task.id, status: "archived" });
    expect(worker.exited).toBe(false);
    await writeFile(path.join(worker.spec.cwd, "worker-result.txt"), "Verified worker implementation\n");
    await mcpCall(worker.spec.runId, "team_complete", { result: "Implemented the requested change" });
    await finish(worker, execution.id, "completed", actor!.id);
    const resumed = leadTurn(execution.id);
    expect(resumed.spec.runId).not.toBe(turn.spec.runId);
    expect(await readFile(path.join(resumed.spec.cwd, "worker-result.txt"), "utf8")).toBe("Verified worker implementation\n");
    expect(tasks.get(core.db, first.task.id)?.status).toBe("archived");
    await mcpCall(resumed.spec.runId, "task_update", { id: first.task.id, status: "done" });
    expect(teamWorkspaces.publications(core.db, execution.id)).toEqual([expect.objectContaining({ sourceActorId: actor!.id, targetActorId: "lead", state: "applied" })]);
    await expect(readFile(path.join(root, "worker-result.txt"))).rejects.toThrow();
    await mcpCall(resumed.spec.runId, "team_complete", { result: "Inspected and verified the integrated files" });
    await finish(resumed, execution.id, "completed");
    expect(core.teams.status(execution.id).state).toBe("completed");
  });

  it("lets agents in another team or ordinary thread discover and move a task through MCP", async () => {
    const owner = await startTeam(draft("codex", true));
    const delegated = await mcpCall(owner.turn.spec.runId, "task_create", {
      title: "Move from another thread",
      spec: "Delivered work",
      execution: "delegate",
      member_key: "worker",
      request_key: "cross-thread-move",
    });
    const other = await startTeam();
    const ordinary = await core.runs.start({
      scope: { thread: newThread(), task: null },
      project,
      agent: "claude",
      model: "fixture-claude",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Move the completed task to Done",
      resume: false,
    });
    const before = core.teams.status(owner.execution.id);
    for (const caller of [other.turn.spec.runId, ordinary.id]) {
      const listed = await mcpCall(caller, "task_list");
      expect(listed).toContainEqual(expect.objectContaining({ id: delegated.task.id }));
      expect(await mcpCall(caller, "task_get", { id: delegated.task.id })).toMatchObject({ id: delegated.task.id });
      for (const status of ["done", "backlog", "archived", "done"]) {
        expect(await mcpCall(caller, "task_update", { id: delegated.task.id, status })).toMatchObject({ id: delegated.task.id, status });
      }
    }
    expect(core.teams.status(owner.execution.id)).toEqual(before);
  });

  it("denies task_start escapes and cross-project memory feedback without touching either resource", async () => {
    const { turn } = await startTeam();
    const unrelatedThread = newThread();
    const unrelated = tasks.insert(core.db, {
      projectId: project.id,
      threadId: unrelatedThread.id,
      title: "Ordinary backlog task",
      spec: "Saved outside team dispatch",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
    });
    await expect(mcpCall(turn.spec.runId, "task_start", { id: unrelated.id })).rejects.toThrow(/team|assignment|manager/i);
    expect(tasks.get(core.db, unrelated.id)).toEqual(unrelated);
    expect(runs.listForTask(core.db, unrelated.id)).toEqual([]);
    const otherProject = projects.insert(core.db, { name: "Other", rootPath: path.join(directory, "other"), gitRemote: null, defaultBranch: null, settings: {} });
    const foreign = memories.upsert(core.db, { projectId: otherProject.id, type: "decision", title: "Private project decision", body: "Belongs to another project", source: "user" }).memory;
    await expect(mcpCall(turn.spec.runId, "memory_feedback", { id: foreign.id, verdict: "wrong" })).rejects.toThrow(/project/i);
    expect(memories.get(core.db, foreign.id)).toEqual(foreign);
    // An agent's memory: one the user wrote can only be retracted by the user.
    const local = memories.upsert(core.db, { projectId: project.id, type: "decision", title: "Own project decision", body: "Can receive feedback", source: "agent" }).memory;
    expect(await mcpCall(turn.spec.runId, "memory_feedback", { id: local.id, verdict: "wrong" })).toEqual({ ok: true });
    expect(memories.get(core.db, local.id)?.status).toBe("retracted");
    expect(scripted.size).toBe(1);
  });

  it("runs a public three-level team through authenticated manager handoffs and projects every actor's history", async () => {
    const team = draft();
    team.members.push(
      {
        key: "manager",
        name: "Manager",
        managerKey: "lead",
        responsibility: "Delegate implementation and combine its result",
        settings: { agent: "claude", model: "fixture-claude", effort: "high", fastMode: false },
      },
      {
        key: "implementer",
        name: "Implementer",
        managerKey: "manager",
        responsibility: "Implement the assigned change",
        settings: { agent: "codex", model: "fixture-codex", effort: "medium", fastMode: false },
      },
      {
        key: "reviewer",
        name: "Reviewer",
        managerKey: "lead",
        responsibility: "Review the combined manager output",
        settings: { agent: "claude", model: "fixture-claude", effort: "medium", fastMode: false },
      },
    );
    const { execution, thread } = await startPublic(team);
    expect(await call("orchestration.availability", {})).toMatchObject({ enabled: true, maxHierarchyDepth: 3 });
    const lead = leadTurn(execution.id);
    const delegate = async (turn: ScriptedTurn, member: string, dependencies: string[] = []) => {
      const response = await mcpCall(turn.spec.runId, "task_create", {
        title: `Perform ${member} assignment`,
        spec: `Complete the requested ${member} work and report its result.`,
        execution: "delegate",
        member_key: member,
        request_key: `assign-${member}`,
        dependencies,
      });
      return core.teams.status(execution.id).actors.find((actor) => actor.taskId === response.task.id)!;
    };
    await expect(delegate(lead, "implementer")).rejects.toThrow(/direct reports/);
    const managerActor = await delegate(lead, "manager");
    const reviewerActor = await delegate(lead, "reviewer", [managerActor.id]);
    await expect(mcpCall(lead.spec.runId, "team_complete", { result: "Premature result" })).rejects.toThrow(/unresolved/);
    await mcpCall(lead.spec.runId, "team_wait", { assignment_ids: [managerActor.id, reviewerActor.id] });
    await finish(lead, execution.id, "waiting");

    const manager = actorTurn(execution.id, managerActor.id);
    expect(manager.spec.systemPromptAppendix).not.toContain("Do not create tasks");
    expect(manager.spec.systemPromptAppendix).toContain("routes your result to your requesting manager");
    await expect(delegate(manager, "reviewer")).rejects.toThrow(/direct reports/);
    const workerActor = await delegate(manager, "implementer");
    expect(tasks.get(core.db, workerActor.taskId!)).toMatchObject({ threadId: thread.id, parentTaskId: managerActor.taskId });
    await expect(mcpCall(manager.spec.runId, "team_complete", { result: "Unfinished subtree" })).rejects.toThrow(/unresolved/);
    await mcpCall(manager.spec.runId, "team_wait", { assignment_ids: [workerActor.id] });
    await finish(manager, execution.id, "waiting", managerActor.id);

    const worker = actorTurn(execution.id, workerActor.id);
    const approval = core.runs.requestApproval(worker.spec.runId, "grandchild-approval", "Bash", { command: "fixture inspection" });
    expect((await call("orchestration.runtime", { threadId: thread.id }))!.executions[0]!.activity).toBe("waiting");
    await call("approvals.resolve", { runId: worker.spec.runId, approvalId: "grandchild-approval", decision: "allow" });
    await expect(approval).resolves.toMatchObject({ decision: "allow" });
    await writeFile(path.join(worker.spec.cwd, "nested-result.txt"), "Worker implementation\n");
    await mcpCall(worker.spec.runId, "team_complete", { result: "Worker implementation ready" });
    await finish(worker, execution.id, "completed", workerActor.id);
    const resumedManager = actorTurn(execution.id, managerActor.id);
    expect(resumedManager.spec.runId).not.toBe(manager.spec.runId);
    expect(await readFile(path.join(resumedManager.spec.cwd, "nested-result.txt"), "utf8")).toBe("Worker implementation\n");
    await writeFile(path.join(resumedManager.spec.cwd, "nested-result.txt"), "Worker implementation\nManager verification\n");
    await mcpCall(resumedManager.spec.runId, "team_complete", { result: "Manager combined and verified the subtree" });
    await finish(resumedManager, execution.id, "completed", managerActor.id);

    const reviewer = actorTurn(execution.id, reviewerActor.id);
    expect(await readFile(path.join(reviewer.spec.cwd, "nested-result.txt"), "utf8")).toBe("Worker implementation\nManager verification\n");
    await mcpCall(reviewer.spec.runId, "team_complete", { result: "Reviewed the combined output" });
    await finish(reviewer, execution.id, "completed", reviewerActor.id);
    const resumedLead = leadTurn(execution.id);
    await mcpCall(resumedLead.spec.runId, "team_complete", { result: "Accepted the reviewed manager output" });
    await finish(resumedLead, execution.id, "completed");
    const history = (await call("orchestration.runtime", { threadId: thread.id }))!.executions[0]!;
    expect(history.state).toBe("completed");
    expect(history.actors.find((actor) => actor.id === managerActor.id)?.runs.map((run) => run.id)).toEqual([manager.spec.runId, resumedManager.spec.runId]);
    expect(history.actors.find((actor) => actor.id === workerActor.id)?.parentId).toBe(managerActor.id);
    for (const actor of history.actors) {
      expect(actor.runs.map((run) => run.id)).toEqual(actor.runIds);
      for (const run of actor.runs) expect(run.startedAt).toBe(runs.get(core.db, run.id)!.startedAt);
    }
    const receipts = teamWorkspaces.publications(core.db, execution.id);
    expect(receipts).toHaveLength(3);
    expect(receipts.find((receipt) => receipt.sourceActorId === managerActor.id)?.includedActorIds).toEqual([managerActor.id, workerActor.id]);
    expect(receipts.filter((receipt) => receipt.sourceActorId === workerActor.id).map((receipt) => receipt.targetActorId)).toEqual([managerActor.id]);
    expect([...scripted.values()].every((turn) => turn.exited)).toBe(true);
  }, 20_000);

  it.each([false, true])("integrates mixed-provider outputs into the lead, dependent reviewer=%s", async (dependent) => {
    await writeFile(path.join(root, "README.md"), "User staged change\n");
    await git(root, ["add", "README.md"]);
    await writeFile(path.join(root, "README.md"), "User staged change plus unstaged input\n");
    await writeFile(path.join(root, "input.txt"), "Untracked source input\n");
    const sourceHead = (await git(root, ["rev-parse", "HEAD"])).stdout;
    const sourceIndex = await readFile(path.join(root, ".git", "index"));
    const team = draft();
    team.members.push(
      { key: "engineer", name: "Engineer", managerKey: "lead", responsibility: "Implement", settings: { agent: "codex", model: "fixture-codex", effort: "medium", fastMode: false } },
      { key: "reviewer", name: "Reviewer", managerKey: "lead", responsibility: "Verify", settings: { agent: "claude", model: "fixture-claude", effort: "high", fastMode: false } },
    );
    const { execution, turn } = await startTeam(team);
    const first = await mcpCall(turn.spec.runId, "task_create", {
      title: "Implement the shared change",
      spec: "Implement the requested feature and retain the test output.",
      execution: "delegate",
      member_key: "engineer",
      request_key: "implementation",
    });
    const firstActor = core.teams.status(execution.id).actors.find((actor) => actor.taskId === first.task.id)!;
    const second = await mcpCall(turn.spec.runId, "task_create", {
      title: "Verify the shared change",
      spec: "Review the implementation and record verification evidence.",
      execution: "delegate",
      member_key: "reviewer",
      request_key: "verification",
      dependencies: dependent ? [firstActor.id] : [],
    });
    const secondActor = core.teams.status(execution.id).actors.find((actor) => actor.taskId === second.task.id)!;
    expect(runs.listForTask(core.db, first.task.id)).toEqual([]);
    expect(runs.listForTask(core.db, second.task.id)).toEqual([]);
    await mcpCall(turn.spec.runId, "team_wait", { assignment_ids: [firstActor.id, secondActor.id] });
    await finish(turn, execution.id, "waiting");
    const engineer = actorTurn(execution.id, firstActor.id);
    expect(engineer.spec).toMatchObject({ agent: "codex", model: "fixture-codex", effort: "medium" });
    expect(await readFile(path.join(engineer.spec.cwd, "README.md"), "utf8")).toBe("User staged change plus unstaged input\n");
    expect(await readFile(path.join(engineer.spec.cwd, "input.txt"), "utf8")).toBe("Untracked source input\n");
    if (dependent) expect(runs.listForTask(core.db, second.task.id)).toEqual([]);
    await writeFile(path.join(engineer.spec.cwd, "implementation.txt"), "Accepted implementation\n");
    await mcpCall(engineer.spec.runId, "team_complete", { result: "Implementation completed and checked" });
    await finish(engineer, execution.id, "completed", firstActor.id);
    const reviewer = actorTurn(execution.id, secondActor.id);
    expect(reviewer.spec).toMatchObject({ agent: "claude", model: "fixture-claude", effort: "high" });
    if (dependent) expect(await readFile(path.join(reviewer.spec.cwd, "implementation.txt"), "utf8")).toBe("Accepted implementation\n");
    else await expect(readFile(path.join(reviewer.spec.cwd, "implementation.txt"))).rejects.toThrow(/ENOENT/);
    expect(core.teams.status(execution.id).actors.find((actor) => actor.id === "lead")?.state).toBe("waiting");
    await writeFile(path.join(reviewer.spec.cwd, "verification.txt"), "Independent verification evidence\n");
    await mcpCall(reviewer.spec.runId, "team_complete", { result: "Verification completed" });
    await finish(reviewer, execution.id, "completed", secondActor.id);
    const resumedLead = leadTurn(execution.id);
    expect(resumedLead.spec.runId).not.toBe(turn.spec.runId);
    expect(await readFile(path.join(resumedLead.spec.cwd, "implementation.txt"), "utf8")).toBe("Accepted implementation\n");
    expect(await readFile(path.join(resumedLead.spec.cwd, "verification.txt"), "utf8")).toBe("Independent verification evidence\n");
    expect(resumedLead.spec.prompt).toContain("Implementation completed and checked");
    expect(resumedLead.spec.prompt).toContain("Verification completed");
    const receipts = teamWorkspaces.publications(core.db, execution.id);
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((receipt) => receipt.sourceActorId))).toEqual(new Set([firstActor.id, secondActor.id]));
    expect(receipts.every((receipt) => receipt.state === "applied")).toBe(true);
    await mcpCall(resumedLead.spec.runId, "team_complete", { result: "Verified both integrated results" });
    await finish(resumedLead, execution.id, "completed");
    expect(core.teams.status(execution.id).state).toBe("completed");
    expect(teamWorkspaces.publications(core.db, execution.id)).toEqual(receipts);
    expect((await git(root, ["rev-parse", "HEAD"])).stdout).toBe(sourceHead);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(sourceIndex);
    await expect(readFile(path.join(root, "implementation.txt"))).rejects.toThrow(/ENOENT/);
    expect([...scripted.values()].every((value) => value.exited)).toBe(true);
  });

  it("stops from the closed lead control while a worker is still preparing its real workspace", async () => {
    const { execution, turn } = await startTeam(draft("codex", true));
    projects.updateSettings(core.db, project.id, { setupScript: 'printf "started\\n" > setup-running; while :; do sleep 1; done' });
    const dispatched = await mcpCall(turn.spec.runId, "task_create", {
      title: "Prepare a cancellable assignment",
      spec: "Set up the isolated workspace before implementation.",
      execution: "delegate",
      member_key: "worker",
      request_key: "cancel-setup",
    });
    const worker = core.teams.status(execution.id).actors.find((actor) => actor.taskId === dispatched.task.id)!;
    await mcpCall(turn.spec.runId, "team_wait", { assignment_ids: [worker.id] });
    emitFinish(turn);
    await vi.waitFor(
      async () => {
        const workspace = teamWorkspaces.get(core.db, execution.id, worker.id);
        expect(workspace?.setupState).toBe("running");
        expect(await readFile(path.join(workspace!.path, "setup-running"), "utf8")).toBe("started\n");
      },
      { timeout: 10_000 },
    );
    expect(turn.exited).toBe(true);
    await call("runs.interrupt", { runId: turn.spec.runId });
    await core.teams.drain();
    expect(core.teams.status(execution.id).state).toBe("stopped");
    expect(core.teams.status(execution.id).actors.find((actor) => actor.id === worker.id)?.state).toBe("cancelled");
    expect(teamWorkspaces.get(core.db, execution.id, worker.id)).toMatchObject({ state: "attention", setupState: "blocked" });
    expect(runs.listForTask(core.db, dispatched.task.id)).toEqual([]);
    expect(scripted.size).toBe(1);
  });

  it("rejects pre-team tokens and denies all team tool authority after a user stops the execution", async () => {
    const thread = newThread();
    const old = await core.runs.start({
      scope: { thread, task: null },
      project,
      agent: "codex",
      model: "fixture-codex",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Previous ordinary conversation",
      resume: false,
    });
    await core.runs.closeAndWait(old.id);
    const { execution, turn } = await startTeam(draft(), thread);
    await expect(mcpCall(old.id, "task_list")).rejects.toThrow("HTTP 404: unknown run");
    await call("runs.close", { runId: turn.spec.runId });
    await core.teams.drain();
    expect(core.teams.status(execution.id).state).toBe("stopped");
    for (const [name, args] of [
      ["team_status", {}],
      ["team_wait", {}],
      ["team_complete", { result: "Late completion" }],
      ["task_list", {}],
      ["task_create", { title: "Late backlog", spec: "This stale token must not write a task." }],
    ] as const)
      await expect(mcpCall(turn.spec.runId, name, args)).rejects.toThrow();
    await expect(mcpCall(turn.spec.runId, "approve", { tool_name: "Bash", tool_use_id: "late-approval", input: {} })).rejects.toThrow("HTTP 404: unknown run");
    expect(tasks.list(core.db)).toEqual([]);
  });

  it("prevents a team actor from starting an ordinary thread through cross-thread messaging", async () => {
    const { turn } = await startTeam();
    const target = newThread("claude");
    // Since cross-thread messaging landed, a team agent may inform a running thread but still never starts an idle one.
    expect(await mcpCall(turn.spec.runId, "thread_send", { id: target.id, text: "Start extra work outside the saved roster" })).toMatchObject({
      delivered: false,
      message: expect.stringMatching(/roster/),
    });
    expect(runs.listForThread(core.db, target.id)).toEqual([]);
    expect(core.threads.get(target.id)?.queued).toEqual([]);
    expect(scripted.size).toBe(1);
  });

  it("respects the disabled team selector and rejects ordinary launches into an internally pinned thread", async () => {
    await call("app.settings.set", { experimentalTeamExecution: false });
    const saved = orchestration.save(core.db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    await expect(
      call("threads.start", {
        projectId: project.id,
        executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
        mode: "act",
        permissionMode: "trusted",
        workspaceMode: "worktree",
        prompt: "Start team",
      }),
    ).rejects.toThrow(/Team execution is disabled/);
    expect(threads.list(core.db)).toEqual([]);
    expect(scripted.size).toBe(0);
    const { thread } = await startTeam();
    const before = runs.listForThread(core.db, thread.id);
    await expect(
      core.runs.start({ scope: { thread, task: null }, project, agent: "codex", model: "fixture-codex", mode: "act", permissionMode: "trusted", prompt: "Bypass coordinator", resume: false }),
    ).rejects.toThrow(/team|coordinator/i);
    await expect(call("runs.start", { threadId: thread.id, agent: "codex", model: "fixture-codex", mode: "act", permissionMode: "trusted", prompt: "Bypass through RPC" })).rejects.toThrow(
      /team|coordinator/i,
    );
    expect(runs.listForThread(core.db, thread.id)).toEqual(before);
    expect(scripted.size).toBe(1);
  });

  it("guards pinned thread lifecycle and configuration mutations before side effects while allowing cosmetic edits", async () => {
    const { thread, turn } = await startTeam();
    const original = threads.get(core.db, thread.id);
    const worktrees = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
    const blocked: Array<() => Promise<unknown>> = [
      () => call("threads.update", { id: thread.id, patch: { agent: "claude", model: "different" } }),
      () => call("threads.update", { id: thread.id, patch: { archived: true } }),
      () => call("threads.update", { id: thread.id, patch: { done: true } }),
      () => call("threads.fork", { id: thread.id }),
      () => call("threads.delete", { id: thread.id }),
      () => call("threads.moveWorkspace", { id: thread.id, to: "worktree" }),
      () => call("threads.compact", { id: thread.id }),
      () => call("threads.queue", { id: thread.id, text: "Bypass the mailbox" }),
      () => call("threads.restore", { id: thread.id, checkpointId: "unrelated-checkpoint" }),
    ];
    for (const invoke of blocked) await expect(invoke()).rejects.toThrow(/team|coordinator|mailbox|attachment/i);
    expect(threads.get(core.db, thread.id)).toEqual(original);
    expect(threads.list(core.db)).toHaveLength(1);
    expect(await call("threads.unqueue", { id: thread.id, messageId: "absent" })).toEqual([]);
    expect((await git(root, ["worktree", "list", "--porcelain"])).stdout).toBe(worktrees);
    expect(await call("threads.update", { id: thread.id, patch: { title: "Renamed team conversation", draft: "Unsent note", pinned: true } })).toMatchObject({
      title: "Renamed team conversation",
      draft: "Unsent note",
      pinnedAt: expect.any(Number),
    });
    await call("runs.send", { runId: turn.spec.runId, text: "Accepted user steering" });
    expect(core.teams.status(core.teams.binding(turn.spec.runId)!.executionId).messages).toContainEqual(expect.objectContaining({ senderId: "user", body: "Accepted user steering" }));
    expect(scripted.size).toBe(1);
  });

  it("guards assignment execution, review and workspace mutation RPCs before preparation", async () => {
    const { turn } = await startTeam(draft("codex", true));
    const result = await mcpCall(turn.spec.runId, "task_create", {
      title: "Assignment with guarded workspace",
      spec: "Retain captured input for a future implementation.",
      execution: "delegate",
      member_key: "worker",
      request_key: "guarded",
    });
    await core.teams.drain();
    const taskId = result.task.id;
    const original = tasks.get(core.db, taskId);
    const prepare = vi.spyOn(core.workspaces, "prepare");
    const blocked: Array<() => Promise<unknown>> = [
      () => call("tasks.start", { taskId }),
      () => call("tasks.prepareWorkspace", { taskId }),
      () => call("workspace.cleanup", { taskId }),
      () => call("tasks.delete", { id: taskId }),
      () => call("runs.start", { taskId, agent: "claude", model: "fixture-claude", mode: "act", permissionMode: "trusted", prompt: "Start outside coordinator" }),
      () => call("review.comments.send", { threadId: tasks.get(core.db, taskId)!.threadId!, taskId, commentIds: ["guarded-comment"] }),
      () => call("review.commit", { taskId, message: "Must not commit team output" }),
      () => call("review.push", { taskId }),
      () => call("review.createPr", { taskId, title: "Must not publish", body: "Unintegrated output" }),
      () => call("review.diff", { taskId }),
      () => call("git.log", { taskId }),
    ];
    for (const invoke of blocked) await expect(invoke()).rejects.toThrow(/team|coordinator/i);
    expect(tasks.get(core.db, taskId)).toEqual(original);
    expect(runs.listForTask(core.db, taskId)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(scripted.size).toBe(1);
  });
});

function probeOutput(binary: string, args: readonly string[], loggedIn: () => boolean): string {
  if (args[0] === "--version") return "2.1.219";
  if (binary.endsWith("claude")) return JSON.stringify({ loggedIn: loggedIn() });
  return loggedIn() ? "Logged in" : "Not logged in";
}
