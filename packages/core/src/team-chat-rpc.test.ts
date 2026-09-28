import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAdapter, ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { orchestration, projects, settings, tasks, teamRuntime, threads, teamRoom } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec, type HarnessId } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let folder: string;
let root: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let rpcId = 0;
let acceptLive = false;
let liveInputs: { runId: string; text: string; attachments: string[] }[];
const member = (key: string, name: string, managerKey: string | null, agent: HarnessId = "codex") => ({
  key,
  name,
  managerKey,
  responsibility: `${name}'s work`,
  settings: { agent, model: agent === "opencode" ? "openrouter/acme/fast" : `fixture-${agent}`, effort: agent === "opencode" ? null : "high", fastMode: false },
});

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-chat-"));
  root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Chat fixture\n");
  await commitAll(root, "Fixture baseline");
  pushed = [];
  turns = new Map();
  acceptLive = false;
  liveInputs = [];
  const start = (spec: RunSpec) => {
    let close!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      close = resolve;
    });
    let closed = false;
    const handle = new RunHandle(spec.runId, {
      done,
      canSteer: () => acceptLive && spec.agent === "codex",
      steer: async (text, attachments) => {
        liveInputs.push({ runId: spec.runId, text, attachments: attachments ?? [] });
        return "accepted";
      },
      // A member's process answers again; the harness records the new turn's input the way the provider would.
      send: async (text, attachments) => {
        turns.set(spec.runId, { spec: { ...turns.get(spec.runId)!.spec, prompt: text, ...(attachments ? { attachments } : {}) }, handle });
      },
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
  vi.spyOn(AcpAdapter.prototype, "start").mockImplementation(start);
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  // Scripted adapters still pass through real launch admission; the fixture needs no installed CLIs.
  const environment = core.environment.current();
  vi.spyOn(core.environment, "current").mockReturnValue({ ...environment, binaries: { codex: "/fixture/codex", claude: "/fixture/claude", opencode: "/fixture/opencode" } });
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => [
    {
      id: agent === "opencode" ? "openrouter/acme/fast" : `fixture-${agent}`,
      label: "Scripted provider",
      agent: agent ?? "codex",
      isDefault: true,
      efforts: ["high"],
      defaultEffort: "high",
      fastMode: { supported: false },
    },
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
  // Several scripted members start at once; under a loaded machine that takes longer than a single run.
  await vi.waitFor(() => expect(core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")?.runId).toBeTruthy(), { timeout: 30000 });
  const runId = core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")!.runId!;
  return { runId, ...turns.get(runId)! };
}
function endTurn(turn: { spec: RunSpec; handle: RunHandle }, text: string) {
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now() });
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

describe("team chat through the public boundary", () => {
  it.each(["codex", "opencode"] as const)("runs an OpenRouter teammate with a %s lead, exchanges messages and continues its session", async (leadAgent) => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "OpenRouter mixed team",
        limits: { ...DEFAULT_TEAM_LIMITS },
        members: [member("lead", "Lead", null, leadAgent), member("router", "Router", "lead", "opencode"), member("reviewer", "Reviewer", "lead", "claude")],
      },
    });
    expect((await call("orchestration.get", { id: saved.team.id }))?.revision.members[1]?.settings).toMatchObject({ agent: "opencode", model: "openrouter/acme/fast" });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "autonomous",
      prompt: "Hello team",
    });
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const lead = await liveRun(execution.id, "lead");
    await mcpCall(lead.runId, "team_say", { text: "Check the implementation", to: ["router"], request_key: "ask-router" });
    const router = await liveRun(execution.id, "member:router");
    expect(router.spec).toMatchObject({ agent: "opencode", model: "openrouter/acme/fast", cwd: lead.spec.cwd, permissionMode: "autonomous" });
    expect(router.spec.systemPromptAppendix).toContain("team_say");
    expect(router.spec.internalMcp?.toolNames).toContain("team_say");
    await mcpCall(router.runId, "team_say", { text: "Review this finding", to: ["reviewer"], request_key: "router-review" });
    const reviewer = await liveRun(execution.id, "member:reviewer");
    expect(reviewer.spec.agent).toBe("claude");
    expect(reviewer.spec.prompt).toContain("Review this finding");
    endTurn(router, "Implementation checked");
    await vi.waitFor(() => expect(core.teams.status(execution.id).actors.find((actor) => actor.id === "member:router")?.state).toBe("waiting"));
    await mcpCall(lead.runId, "team_say", { text: "Check the follow-up", to: ["router"], request_key: "router-follow-up" });
    await core.teams.drain();
    const continued = await liveRun(execution.id, "member:router");
    expect(continued.runId).toBe(router.runId);
    expect(continued.spec.prompt).toContain("Check the follow-up");
    endTurn(continued, "Follow-up checked");
    endTurn(reviewer, "Review complete");
    endTurn(lead, "Team check complete");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    expect(tasks.list(core.db)).toEqual([]);
  });

  it("answers and routes a correction with all three worker slots occupied while another team remains independent", async () => {
    acceptLive = true;
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Busy team",
        limits: { ...DEFAULT_TEAM_LIMITS, maxConcurrentAgents: 3 },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("one", "One", "lead"), member("two", "Two", "lead"), member("three", "Three", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "@One @Two @Three work on your assigned parts",
    });
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const workers = await Promise.all(["one", "two", "three"].map((key) => liveRun(execution.id, `member:${key}`)));
    await core.teams.drain();
    expect(core.teams.status(execution.id).actors.find((actor) => actor.id === "lead")?.state).toBe("waiting");
    await call("orchestration.send", { threadId: thread.id, text: "Change only One's avatar to a square; keep the other work running", requestKey: "correction", now: true });
    const lead = await liveRun(execution.id, "lead");
    expect(lead.spec.prompt).toContain("Change only One's avatar to a square");
    expect(lead.spec.systemPromptAppendix).toContain("acknowledge the correction promptly");
    lead.handle.emit("event", {
      type: "message.completed",
      role: "assistant",
      messageId: "ack-correction",
      runId: lead.runId,
      text: "Understood. I’m asking One to use a square. Two and Three are still working.",
      ts: Date.now(),
    });
    const receipt = await mcpCall(lead.runId, "team_say", { to: ["one"], text: "Use a square avatar now", request_key: "relay-correction" });
    expect(receipt).toMatchObject({ posted: true, delivered: [{ member: "one", delivery: "sending" }] });
    await core.teams.drain();
    expect(liveInputs).toHaveLength(1);
    expect(liveInputs[0]).toMatchObject({ runId: workers[0]!.runId, text: expect.stringContaining("Use a square avatar now") });
    expect(workers.every((worker) => core.runs.isBusy(worker.runId))).toBe(true);
    expect(core.teams.status(execution.id).attempts).toHaveLength(4);
    const interruptions = [...workers, lead].map((turn) => vi.spyOn(turn.handle, "interrupt"));
    // The reserved lead slot belongs to this team; another team has no implicit provider-wide ceiling.
    const other = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Another request",
    });
    const otherExecution = teamRuntime.activeForThread(core.db, other.thread.id)!;
    const otherLead = await liveRun(otherExecution.id, "lead");
    await call("orchestration.send", { threadId: other.thread.id, text: "A correction for the second lead", requestKey: "second-correction", now: true });
    await core.teams.drain();
    expect(core.teams.status(otherExecution.id).actors.find((actor) => actor.id === "lead")?.state).toBe("running");
    expect(core.teams.status(otherExecution.id).attempts).toHaveLength(1);
    expect(core.teams.status(execution.id).attempts).toHaveLength(4);
    expect(liveInputs).toHaveLength(2);
    expect(liveInputs[1]).toMatchObject({ runId: otherLead.runId, text: expect.stringContaining("A correction for the second lead") });
    expect([...workers, lead, otherLead].every((turn) => core.runs.isBusy(turn.runId))).toBe(true);
    await call("orchestration.stop", { threadId: other.thread.id, executionId: otherExecution.id });
    expect([...workers, lead].every((turn) => core.runs.isBusy(turn.runId))).toBe(true);
    for (const interrupt of interruptions) expect(interrupt).not.toHaveBeenCalled();
    const report = await call("orchestration.runtime", { threadId: thread.id });
    expect(report!.executions[0]!.chat!.find((message) => message.text === "Use a square avatar now")!.to).toEqual([{ actorId: "member:one", name: "One", state: "claimed", live: "accepted" }]);
    expect(report!.executions[0]!.chat!.find((message) => message.text === "Use a square avatar now")!.seenBy).toEqual([]);
    workers[0]!.handle.emit("event", { type: "session.started", runId: workers[0]!.runId, agent: "codex", model: "fixture-codex", externalSessionId: "live-reader", ts: Date.now() });
    endTurn(workers[0]!, "Square avatar is ready.");
    for (const worker of workers.slice(1)) endTurn(worker, "Work is ready.");
    endTurn(lead, "All members are done.");
    await vi.waitFor(
      async () => {
        const updated = await call("orchestration.runtime", { threadId: thread.id });
        expect(updated!.executions[0]!.chat!.find((message) => message.text === "Use a square avatar now")!.seenBy).toContainEqual({ actorId: "member:one", name: "One" });
      },
      { timeout: 15000 },
    );
    await call("orchestration.stop", { threadId: thread.id, executionId: execution.id });
  });

  it.each(["current", "worktree"] as const)("greets everyone in %s: all members share the lead workspace across turns and return to idle", async (workspaceMode) => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Feature team",
        limits: { ...DEFAULT_TEAM_LIMITS, maxConcurrentAgents: 5 },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Orc general", null), member("assistant", "Assistant General", "lead", "claude"), member("mark", "Mark", "assistant"), member("melo", "Melo", "assistant")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      workspaceMode,
      prompt: "Hello guys!",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    const opening = await liveRun(first.id, "lead");
    expect(threads.get(core.db, thread.id)?.workspaceMode).toBe(workspaceMode);
    expect(await realpath(opening.spec.cwd)).toBe(await realpath(workspaceMode === "current" ? root : threads.get(core.db, thread.id)!.worktreePath!));
    expect(core.teams.status(first.id).actors.map((actor) => [actor.id, actor.state])).toEqual([
      ["lead", "running"],
      ["member:assistant", "waiting"],
      ["member:mark", "waiting"],
      ["member:melo", "waiting"],
    ]);
    endTurn(opening, "Hey! What are we working on today?");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    expect(tasks.list(core.db, { projectId: project.id })).toHaveLength(0);

    // Addressing everyone starts one execution where every member runs at once.
    const view = await call("orchestration.send", { threadId: thread.id, text: "Can everyone on this team reply please", requestKey: "hello-all", to: ["all"] });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    expect(second.id).not.toBe(first.id);
    const chat = view.executions.at(-1)!.chat!;
    expect(chat).toHaveLength(1);
    expect(chat[0]!.to.map((item) => item.name).sort()).toEqual(["Assistant General", "Mark", "Melo"]);
    await vi.waitFor(
      () =>
        expect(core.teams.status(second.id).actors.map((actor) => [actor.id, actor.state, actor.error])).toEqual([
          ["lead", "running", null],
          ["member:assistant", "running", null],
          ["member:mark", "running", null],
          ["member:melo", "running", null],
        ]),
      { timeout: 15000 },
    );
    const runs = await Promise.all(["lead", "member:assistant", "member:mark", "member:melo"].map((id) => liveRun(second.id, id)));
    const workspace = await realpath(workspaceMode === "current" ? root : threads.get(core.db, thread.id)!.worktreePath!);
    for (const run of runs) expect(await realpath(run.spec.cwd)).toBe(workspace);
    expect(runs[0]!.spec.prompt).toContain("Can everyone on this team reply please");
    expect(runs[2]!.spec.prompt).toContain("chat from user to lead, member:assistant, member:mark, member:melo]");
    expect(runs[2]!.spec.systemPromptAppendix).toContain("TEAM CHAT: You are Mark (mark)");
    expect(runs[1]!.spec.agent).toBe("claude");
    // A replay of the same key changes nothing.
    expect((await call("orchestration.send", { threadId: thread.id, text: "Can everyone on this team reply please", requestKey: "hello-all", to: ["all"] })).executions).toHaveLength(2);
    await expect(call("orchestration.send", { threadId: thread.id, text: "Can everyone on this team reply please", requestKey: "hello-all", to: ["mark"] })).rejects.toThrow(/different/);
    // Mark tells Melo directly through the real MCP tool. Melo already holds the user's request, so it reads Mark's message after its turn without owing a reply.
    const said = await mcpCall(runs[2]!.runId, "team_say", { text: "I'll take src/app.ts", to: ["melo"], request_key: "claim-app" });
    expect(said).toEqual({ posted: true, delivered: [{ member: "melo", delivery: "read" }] });
    for (const [index, name] of ["Orc general", "Assistant General", "Mark", "Melo"].entries()) endTurn(runs[index]!, `Hello from ${name}.`);
    // Melo reads Mark's claim once its turn ends, so it runs once more and then the team is idle.
    await vi.waitFor(() => expect(core.teams.status(second.id).attempts.filter((attempt) => attempt.actorId === "member:melo" && attempt.state === "running")).toHaveLength(1), { timeout: 15000 });
    await vi.waitFor(() => expect(core.teams.status(second.id).attempts.filter((attempt) => attempt.actorId === "member:melo")).toHaveLength(2), { timeout: 15000 });
    const melo = await liveRun(second.id, "member:melo");
    expect(melo.spec.prompt).toContain("Mark to Melo (to you): I'll take src/app.ts");
    expect(melo.spec.prompt).toContain("AMBIENT TURN");
    endTurn(melo, "Got it, I'll take src/router.ts; tell me when you're done.");
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    expect(tasks.list(core.db, { projectId: project.id })).toHaveLength(0);
    const finished = (await call("orchestration.runtime", { threadId: thread.id }))!.executions.at(-1)!;
    expect(finished.actors.filter((actor) => actor.participant).map((actor) => actor.runs.length)).toEqual([1, 1, 2]);
    expect(finished.chat!.map((entry) => [entry.senderName, entry.to.map((item) => item.name)])).toEqual([
      ["You", ["Assistant General", "Mark", "Melo"]],
      ["Mark", ["Melo"]],
    ]);
    expect((await call("threads.search", { query: "src/router", projectId: project.id }))[0]).toMatchObject({ threadId: thread.id, member: { key: "melo", name: "Melo" } });
  });

  it("defaults to addressed work without spending turns on background acknowledgments", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: { name: "Quiet default", limits: { ...DEFAULT_TEAM_LIMITS }, members: [member("lead", "Lead", null), member("one", "One", "lead")] },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Hello",
    });
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const lead = await liveRun(execution.id, "lead");
    expect(lead.spec.systemPromptAppendix).toContain("Do not request or send routine read acknowledgments");
    endTurn(lead, "Hello.");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"));
    expect(core.teams.status(execution.id).attempts.map((attempt) => attempt.actorId)).toEqual(["lead"]);
    expect((await call("orchestration.runtime", { threadId: thread.id }))!.executions[0]!.initialPrompt.seenBy).toEqual([{ actorId: "lead", name: "Lead" }]);
  });

  it("lets a team explicitly enable silent background reads", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Greeting team",
        discussion: { ambientRounds: 1, peerFollowUps: 0, mentionOnly: [] },
        limits: { ...DEFAULT_TEAM_LIMITS, maxConcurrentAgents: 5 },
        members: [
          member("lead", "Orc general", null),
          member("assistant", "Assistant General", "lead", "claude"),
          member("mark", "Mark", "assistant"),
          member("melo", "Melo", "assistant"),
          member("sam", "Sam", "lead"),
        ],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Hello everyone!",
    });
    await core.teams.drain();
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const opening = await liveRun(execution.id, "lead");
    expect((await call("orchestration.runtime", { threadId: thread.id }))!.executions.at(-1)!.initialPrompt.seenBy).toEqual([]);
    endTurn(opening, "Hello! Ready when you are.");
    // Followers wake once the room settles. The lead's reply is a colleague's message, which does not wake them a second time.
    const followers = ["member:assistant", "member:mark", "member:melo", "member:sam"];
    // The lead's completion waits for the shared workspace, which each reader releases when its turn ends, so the reads are ended as they come.
    for (const id of followers) {
      const read = await liveRun(execution.id, id);
      expect(read.spec.prompt).toContain("AMBIENT TURN: Nobody is waiting for your reply");
      expect(read.spec.prompt).toContain("User to Orc general (lead): Hello everyone!");
      endTurn(read, "Nothing to add.");
    }
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    const record = core.teams.status(execution.id);
    expect(record.attempts.map((attempt) => [attempt.actorId, attempt.reason, attempt.outcome]).sort()).toEqual(
      [["lead", "lead", "public"], ...followers.map((id) => [id, "ambient", "silent"])].sort(),
    );
    expect(tasks.list(core.db, { projectId: project.id })).toHaveLength(0);
    const { teamRoom } = await import("@openorc/db");
    expect(teamRoom.list(core.db, record.instanceId).map((event) => event.source)).toEqual(["prompt", "reply"]);
    const view = (await call("orchestration.runtime", { threadId: thread.id }))!.executions.at(-1)!;
    expect(view.actors.filter((actor) => actor.participant).map((actor) => actor.runs.map((run) => [run.reason, run.silent ?? false]))).toEqual(followers.map(() => [["ambient", true]]));
    expect(view.initialPrompt.seenBy?.map((reader) => reader.actorId).sort()).toEqual(["lead", ...followers].sort());
    expect(view.chat ?? []).toHaveLength(0);
  });

  it("addresses a single member on an idle team without waking the lead, and refuses unknown members", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Pair",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("mark", "Mark", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    endTurn(await liveRun(first.id, "lead"), "Ready.");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    await expect(call("orchestration.send", { threadId: thread.id, text: "Hi", requestKey: "bad", to: ["nobody"] })).rejects.toThrow(/No team member/);
    await call("orchestration.send", { threadId: thread.id, text: "Mark, what did you find?", requestKey: "ask-mark", to: ["mark"] });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    const mark = await liveRun(second.id, "member:mark");
    expect(core.teams.status(second.id).actors.find((actor) => actor.id === "lead")?.state).toBe("waiting");
    expect(mark.spec.prompt).toContain("Mark, what did you find?");
    endTurn(mark, "Two flaky tests.");
    // Nobody else was addressed, so the conversation is idle again; the lead never ran.
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    expect(core.teams.status(second.id).attempts.map((attempt) => attempt.actorId)).toEqual(["member:mark"]);
    expect(turns.size).toBe(2);
    // The lead's next turn, in a new execution, still reads the earlier chat.
    await call("orchestration.send", { threadId: thread.id, text: "Thanks, lead please summarize", requestKey: "summarize" });
    const third = teamRuntime.activeForThread(core.db, thread.id)!;
    expect(third.id).not.toBe(second.id);
    const lead = await liveRun(third.id, "lead");
    expect(lead.spec.prompt).toContain("User to Mark: Mark, what did you find?");
    expect(lead.spec.prompt).toContain("Mark said: Two flaky tests.");
    endTurn(lead, "Summary: two flaky tests.");
    await vi.waitFor(() => expect(core.teams.status(third.id).state).toBe("completed"), { timeout: 15000 });
  });

  it("keeps one numbered room across executions, hands each member only what it missed, and pages history through team_history", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Pair",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("mark", "Mark", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    const instanceId = first.instanceId;
    const opening = await liveRun(first.id, "lead");
    // The lead's own instruction is not repeated to it as room input.
    expect(opening.spec.prompt).not.toContain("Team chat since your last turn");
    endTurn(opening, "Ready when you are.");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    await call("orchestration.send", { threadId: thread.id, text: "@Mark what did you find?", requestKey: "ask-mark" });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    const mark = await liveRun(second.id, "member:mark");
    // Mark missed the opening exchange; the addressed message itself arrives as his direction, not twice.
    expect(mark.spec.prompt).toContain("#1 User to Lead (lead): Kickoff");
    expect(mark.spec.prompt).toContain("#2 Lead (lead) said: Ready when you are.");
    expect(mark.spec.prompt).toContain("chat from user]\n@Mark what did you find?");
    expect(mark.spec.prompt.match(/what did you find\?/g)).toHaveLength(1);
    const page = (await mcpCall(mark.runId, "team_history", { limit: 2 })) as { events: { seq: number; authorName: string; body: string }[]; latestSeq: number };
    expect(page.latestSeq).toBe(3);
    expect(page.events.map((event) => [event.seq, event.authorName])).toEqual([
      [2, "Lead (lead)"],
      [3, "User"],
    ]);
    expect(((await mcpCall(mark.runId, "team_history", { before_seq: 2 })) as { events: { seq: number }[] }).events.map((event) => event.seq)).toEqual([1]);
    endTurn(mark, "Two flaky tests.");
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    // A message to an idle team opens a new execution, so it is admitted as that execution's prompt.
    expect(teamRoom.list(core.db, instanceId).map((event) => [event.seq, event.authorId, event.source])).toEqual([
      [1, "user", "prompt"],
      [2, "lead", "reply"],
      [3, "user", "prompt"],
      [4, "member:mark", "reply"],
    ]);
    expect(teamRoom.cursor(core.db, instanceId, "member:mark")).toMatchObject({ deliveredSeq: 3, assessedSeq: 3 });
    // The lead reads only what it has not been handed: Mark's answer, not the opening again.
    await call("orchestration.send", { threadId: thread.id, text: "Lead, please summarize", requestKey: "summarize" });
    const third = teamRuntime.activeForThread(core.db, thread.id)!;
    const lead = await liveRun(third.id, "lead");
    expect(lead.spec.prompt).toContain("#4 Mark said: Two flaky tests.");
    expect(lead.spec.prompt).toContain("#3 User to Mark: @Mark what did you find?");
    expect(lead.spec.prompt).not.toContain("#1 User");
    endTurn(lead, "Summary: two flaky tests.");
    await vi.waitFor(() => expect(core.teams.status(third.id).state).toBe("completed"), { timeout: 15000 });
    expect(teamRoom.deliveries(core.db, instanceId).every((delivery) => delivery.state === "confirmed")).toBe(true);
    // The cursor covers what was handed over; the lead's own closing reply (#6) is never handed to it.
    expect(teamRoom.cursor(core.db, instanceId, "lead").deliveredSeq).toBe(5);
    expect(teamRoom.pending(core.db, instanceId, "lead")).toEqual([]);
  });

  it("answers a member's next question on the process it already has, and refuses a tool call that arrives between turns", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Pair",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("mark", "Mark", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const execution = teamRuntime.activeForThread(core.db, thread.id)!;
    const lead = await liveRun(execution.id, "lead");

    await call("orchestration.send", { threadId: thread.id, text: "Mark, first question", requestKey: "q1", to: ["mark"] });
    const first = await liveRun(execution.id, "member:mark");
    expect(first.spec.prompt).toContain("Mark, first question");
    // A tool call during the turn carries authority.
    expect(await mcpCall(first.runId, "team_say", { text: "Working on it", to: ["lead"], request_key: "during" })).toMatchObject({ posted: true });
    endTurn(first, "First answer.");
    await vi.waitFor(() => expect(core.teams.status(execution.id).attempts.filter((item) => item.actorId === "member:mark" && item.state === "closed")).toHaveLength(1), { timeout: 15000 });

    // The session is still open, so the call reaches the app; its turn has ended, so the app refuses it.
    expect(core.runs.isLive(first.runId)).toBe(true);
    await expect(mcpCall(first.runId, "team_say", { text: "After my turn", to: ["lead"], request_key: "after" })).rejects.toThrow(/no longer has active authority/);

    await call("orchestration.send", { threadId: thread.id, text: "Mark, second question", requestKey: "q2", to: ["mark"] });
    const second = await liveRun(execution.id, "member:mark");
    // The same process answered again, and the app knows which of its turns this is.
    expect(second.runId).toBe(first.runId);
    expect(second.spec.prompt).toContain("Mark, second question");
    const turns = core.teams.status(execution.id).attempts.filter((item) => item.actorId === "member:mark");
    expect(turns.map((item) => [item.runId, item.processTurn ?? null])).toEqual([
      [first.runId, null],
      [first.runId, 1],
    ]);
    expect(core.db.stmt("SELECT COUNT(*) AS total FROM team_run_bindings WHERE execution_id=?").get(execution.id)).toEqual({ total: 2 });
    // Authority works on a warm turn exactly as on a fresh one.
    expect(await mcpCall(second.runId, "team_say", { text: "Second answer coming", to: ["lead"], request_key: "during-2" })).toMatchObject({ posted: true });
    endTurn(second, "Second answer.");
    await vi.waitFor(() => expect(core.teams.status(execution.id).attempts.filter((item) => item.actorId === "member:mark" && item.state === "closed")).toHaveLength(2), { timeout: 15000 });
    endTurn(lead, "Thanks Mark.");
    // Mark spoke to the lead during its turn, so the lead reads that before the conversation is finished.
    await vi.waitFor(() => expect(core.teams.status(execution.id).attempts.filter((item) => item.actorId === "lead")).toHaveLength(2), { timeout: 15000 });
    const leadAgain = await liveRun(execution.id, "lead");
    expect(leadAgain.spec.prompt).toContain("Second answer coming");
    endTurn(leadAgain, "All done.");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    // The conversation is over, so nobody is left holding a session.
    expect(core.runs.isLive(first.runId)).toBe(false);
    expect(tasks.list(core.db, { projectId: project.id })).toHaveLength(0);
  });

  it("gives a fork its own copy of the room up to the forked reply, which its members read as history", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Pair",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("mark", "Mark", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    const opening = await liveRun(first.id, "lead");
    endTurn(opening, "Ready when you are.");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    await call("orchestration.send", { threadId: thread.id, text: "Mark, anything blocking?", requestKey: "ask", to: ["mark"] });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    endTurn(await liveRun(second.id, "member:mark"), "Nothing blocking.");
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    const source = teamRoom.list(core.db, first.instanceId);
    // A message to an idle team opens a new execution, so it is admitted as that execution's prompt, not as chat.
    expect(source.map((event) => [event.authorId, event.source])).toEqual([
      ["user", "prompt"],
      ["lead", "reply"],
      ["user", "prompt"],
      ["member:mark", "reply"],
    ]);
    // Fork from the lead's reply: the room copy ends there, so Mark's exchange stays with the source.
    const forked = await call("threads.fork", { id: thread.id, upToRunId: opening.runId, requestKey: "fork-room" });
    if ("rejected" in forked) throw new Error(forked.rejected);
    const child = orchestration.getInstance(core.db, forked.id)!;
    const copy = teamRoom.list(core.db, child.id);
    expect(copy.map((event) => [event.authorId, event.body, event.source, event.executionId])).toEqual([
      ["user", "Kickoff", "prompt", null],
      ["lead", "Ready when you are.", "reply", null],
    ]);
    expect(copy.map((event) => event.id)).not.toEqual(source.slice(0, 2).map((event) => event.id));
    expect(teamRoom.list(core.db, first.instanceId)).toHaveLength(4);
    // A member of the fork reads the copied history like any fresh session, then the new message.
    await call("orchestration.send", { threadId: forked.id, text: "Mark, we forked; carry on", requestKey: "fork-ask", to: ["mark"] });
    const forkExecution = teamRuntime.activeForThread(core.db, forked.id)!;
    const mark = await liveRun(forkExecution.id, "member:mark");
    expect(mark.spec.prompt).toContain("User to Lead (lead): Kickoff");
    expect(mark.spec.prompt).toContain("Lead (lead) said: Ready when you are.");
    expect(mark.spec.prompt).not.toContain("Nothing blocking.");
    endTurn(mark, "Carrying on.");
    await vi.waitFor(() => expect(core.teams.status(forkExecution.id).state).toBe("completed"), { timeout: 15000 });
    expect(teamRoom.list(core.db, child.id).map((event) => event.body)).toEqual(["Kickoff", "Ready when you are.", "Mark, we forked; carry on", "Carrying on."]);
  });

  it("rebuilds the room for a conversation older than the log and places its members at the end", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Pair",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("mark", "Mark", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    endTurn(await liveRun(first.id, "lead"), "Ready.");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    await call("orchestration.send", { threadId: thread.id, text: "Mark, status?", requestKey: "status", to: ["mark"] });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    endTurn(await liveRun(second.id, "member:mark"), "All green.");
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    // A database from before the room log has journals but no room rows.
    core.db.stmt("DELETE FROM team_room_deliveries WHERE instance_id=?").run(first.instanceId);
    core.db.stmt("DELETE FROM team_room_cursors WHERE instance_id=?").run(first.instanceId);
    core.db.stmt("DELETE FROM team_room_events WHERE instance_id=?").run(first.instanceId);
    await call("orchestration.send", { threadId: thread.id, text: "Lead, next steps", requestKey: "next" });
    const third = teamRuntime.activeForThread(core.db, thread.id)!;
    const events = teamRoom.list(core.db, first.instanceId);
    expect(events.map((event) => [event.authorId, event.source, event.body])).toEqual([
      ["user", "legacy", "Kickoff"],
      ["lead", "legacy", "Ready."],
      ["user", "legacy", "Mark, status?"],
      ["member:mark", "legacy", "All green."],
      ["user", "prompt", "Lead, next steps"],
    ]);
    // Migrated sessions already read that history through the old transcript; only the new message is handed to the lead.
    const lead = await liveRun(third.id, "lead");
    expect(lead.spec.prompt).not.toContain("Team chat since your last turn");
    expect(teamRoom.cursor(core.db, first.instanceId, "member:mark")).toMatchObject({ deliveredSeq: 4, unknown: true });
    endTurn(lead, "Plan follows.");
    await vi.waitFor(() => expect(core.teams.status(third.id).state).toBe("completed"), { timeout: 15000 });
  });

  it.each(["current", "worktree"] as const)("starts an addressed member in %s with the lead idle and retains its checkpoint for a move", async (workspaceMode) => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Pair",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("mark", "Mark", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      workspaceMode,
      prompt: "@Mark say hi",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    const mark = await liveRun(first.id, "member:mark");
    expect(mark.spec.prompt).toContain("@Mark say hi");
    expect((await realpath(mark.spec.cwd)) === (await realpath(root))).toBe(workspaceMode === "current");
    await writeFile(path.join(mark.spec.cwd, "member-result.txt"), "Member result\n");
    expect(core.teams.status(first.id).actors.find((actor) => actor.id === "lead")?.state).toBe("waiting");
    endTurn(mark, "Hi!");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    expect(core.teams.status(first.id).attempts.map((attempt) => attempt.actorId)).toEqual(["member:mark"]);
    expect((await call("threads.checkpoints", { id: thread.id })).some((checkpoint) => checkpoint.runId === mark.runId)).toBe(true);
    const moved = await call("threads.moveWorkspace", { id: thread.id, to: workspaceMode === "current" ? "worktree" : "current", requestKey: "member-only-move" });
    if ("rejected" in moved) throw new Error(moved.rejected);
    expect(await readFile(path.join(moved.worktreePath ?? root, "member-result.txt"), "utf8")).toBe("Member result\n");
  });

  it("exposes claims and changed files through the real tools, the runtime view and thread checkpoints", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Pair",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Lead", null), member("mark", "Mark", "lead"), member("melo", "Melo", "lead")],
      },
    });
    // The team starts from the checkout as it is, uncommitted files included; those are not the lead's changes.
    await writeFile(path.join(root, "notes.md"), "uncommitted before the team started\n");
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    endTurn(await liveRun(first.id, "lead"), "Ready.");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    expect(core.teams.status(first.id).attempts[0]?.changedFiles).toEqual([]);
    await call("orchestration.send", { threadId: thread.id, text: "Mark and Melo, split the work", requestKey: "split", to: ["mark", "melo"] });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    const [mark, melo] = await Promise.all([liveRun(second.id, "member:mark"), liveRun(second.id, "member:melo")]);
    expect(await mcpCall(mark.runId, "team_claim", { paths: ["src/app.ts"], note: "routing" })).toEqual({ claims: [{ path: "src/app.ts", note: "routing" }], held: [] });
    await expect(mcpCall(melo.runId, "team_claim", { paths: ["src/app.ts"] })).rejects.toThrow(/Mark holds src\/app.ts/);
    const status = (await mcpCall(melo.runId, "team_status", {})) as { claims: { actorId: string; path: string; releasedAt: number | null }[] };
    expect(status.claims.map((claim) => [claim.actorId, claim.path, claim.releasedAt])).toEqual([["member:mark", "src/app.ts", null]]);
    let view = (await call("orchestration.runtime", { threadId: thread.id }))!.executions.at(-1)!;
    expect(view.actors.find((actor) => actor.id === "member:mark")?.claims).toEqual([{ path: "src/app.ts", note: "routing", createdAt: expect.any(Number) }]);
    await mkdir(path.join(mark.spec.cwd, "src"), { recursive: true });
    await writeFile(path.join(mark.spec.cwd, "src", "app.ts"), "export const app = 1;\n");
    await writeFile(path.join(mark.spec.cwd, "src", "extra.ts"), "export const extra = 2;\n");
    endTurn(mark, "Routing done.");
    await vi.waitFor(() => expect(core.teams.status(second.id).attempts.find((attempt) => attempt.actorId === "member:mark")?.changedFiles).toEqual(["src/app.ts", "src/extra.ts"]), {
      timeout: 15000,
    });
    const checkpoints = await call("threads.checkpoints", { id: thread.id });
    expect(checkpoints.some((checkpoint) => checkpoint.runId === mark.runId)).toBe(true);
    endTurn(melo, "Tests planned.");
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    view = (await call("orchestration.runtime", { threadId: thread.id }))!.executions.at(-1)!;
    expect(view.actors.find((actor) => actor.id === "member:mark")?.runs[0]?.changedFiles).toEqual(["src/app.ts", "src/extra.ts"]);
    const turnId = view.actors.find((actor) => actor.id === "member:mark")!.runs[0]!.turnId;
    const scope = { threadId: thread.id, executionId: second.id, turnId };
    const changes = await call("orchestration.turnChanges", scope);
    expect(changes).toMatchObject({
      files: [
        { path: "src/app.ts", added: 1, removed: 0 },
        { path: "src/extra.ts", added: 1, removed: 0 },
      ],
      patch: null,
      attribution: "shared-checkpoint",
    });
    await writeFile(path.join(mark.spec.cwd, "src", "app.ts"), "later concurrent edit\n");
    const review = await call("orchestration.turnChanges", { ...scope, includePatch: true });
    expect(review.patch).toContain("+export const app = 1;");
    expect(review.patch).not.toContain("later concurrent edit");
    expect(review.patch).not.toContain("notes.md");
    const selected = await call("orchestration.turnChanges", { ...scope, includePatch: true, paths: ["src/app.ts"] });
    expect(selected.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(selected.patch).toContain("+export const app = 1;");
    expect(selected.patch).not.toContain("src/extra.ts");
    await expect(call("orchestration.turnChanges", { ...scope, paths: ["notes.md"] })).rejects.toThrow(/Select files listed/);
    await expect(call("orchestration.turnChanges", { ...scope, paths: ["src/*"] })).rejects.toThrow(/Select files listed/);
    await expect(call("orchestration.turnChanges", { ...scope, threadId: "unrelated" })).rejects.toThrow(/does not belong/);
    await expect(call("orchestration.turnChanges", { ...scope, turnId: "unknown" })).rejects.toThrow(/no saved/);
    expect(view.actors.find((actor) => actor.id === "member:mark")?.claims).toEqual([]);
    expect(core.teams.status(second.id).claims?.every((claim) => claim.releasedAt !== null)).toBe(true);
  });

  it("shows a lead relay the members only read, with their reading as its delivery", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Relay team",
        limits: { ...DEFAULT_TEAM_LIMITS, maxConcurrentAgents: 5 },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Dario", null), member("sam", "Sam", "lead"), member("tibo", "Tibo", "lead")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    endTurn(await liveRun(first.id, "lead"), "Ready.");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    await call("orchestration.send", { threadId: thread.id, text: "hello @everyone say hi", requestKey: "hello-all" });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    const [lead, sam, tibo] = await Promise.all(["lead", "member:sam", "member:tibo"].map((id) => liveRun(second.id, id)));
    const relayed = await mcpCall(lead!.runId, "team_say", { text: "Alex asked the whole team to say hi. @Sam @Tibo, drop a quick hello.", to: ["sam", "tibo"], request_key: "relay" });
    expect(relayed).toEqual({
      posted: true,
      delivered: [
        { member: "sam", delivery: "read" },
        { member: "tibo", delivery: "read" },
      ],
    });
    const before = (await call("orchestration.runtime", { threadId: thread.id }))!.executions.at(-1)!;
    expect(before.chat!.map((entry) => [entry.senderName, entry.to.map((item) => [item.name, item.state, item.waitReason])])).toEqual([
      [
        "You",
        [
          ["Sam", "claimed", undefined],
          ["Tibo", "claimed", undefined],
        ],
      ],
      [
        "Dario",
        [
          ["Sam", "pending", "Reads it on their next turn."],
          ["Tibo", "pending", "Reads it on their next turn."],
        ],
      ],
    ]);
    endTurn(sam!, "Hi everyone! Sam here.");
    endTurn(tibo!, "Hi everyone! Tibo here.");
    endTurn(lead!, "Hi all.");
    // Each member reads the relay after its own hello and adds nothing; the room keeps one hello per member.
    for (const id of ["member:sam", "member:tibo"]) {
      await vi.waitFor(() => expect(core.teams.status(second.id).attempts.filter((attempt) => attempt.actorId === id)).toHaveLength(2), { timeout: 15000 });
      const read = await liveRun(second.id, id);
      expect(read.spec.prompt).toContain("(to you): Alex asked the whole team to say hi.");
      expect(read.spec.prompt).toContain("AMBIENT TURN");
      endTurn(read, "Already said hi.");
    }
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    const after = (await call("orchestration.runtime", { threadId: thread.id }))!.executions.at(-1)!;
    const relay = after.chat!.find((entry) => entry.senderName === "Dario")!;
    expect(relay.to.map((item) => [item.name, item.state])).toEqual([
      ["Sam", "delivered"],
      ["Tibo", "delivered"],
    ]);
    expect(relay.seenBy?.map((reader) => reader.name).sort()).toEqual(["Sam", "Tibo"]);
    expect(after.actors.filter((actor) => actor.participant).map((actor) => actor.runs.map((run) => [run.reason, run.silent ?? false]))).toEqual([
      [
        ["addressed", false],
        ["ambient", true],
      ],
      [
        ["addressed", false],
        ["ambient", true],
      ],
    ]);
    const { teamRoom } = await import("@openorc/db");
    expect(
      teamRoom
        .list(core.db, second.instanceId)
        .filter((event) => event.source === "reply" && event.executionId === second.id)
        .map((event) => event.body)
        .sort(),
    ).toEqual(["Hi all.", "Hi everyone! Sam here.", "Hi everyone! Tibo here."]);
  });

  it("addresses members from @mentions in the text, including multi-word names and @everyone, without an explicit to list", async () => {
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Mentions",
        limits: { ...DEFAULT_TEAM_LIMITS, maxConcurrentAgents: 5 },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [member("lead", "Orc general", null), member("assistant", "Assistant General", "lead", "claude"), member("mark", "Mark", "assistant")],
      },
    });
    const { thread } = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Kickoff",
    });
    await core.teams.drain();
    const first = teamRuntime.activeForThread(core.db, thread.id)!;
    endTurn(await liveRun(first.id, "lead"), "Ready.");
    await vi.waitFor(() => expect(core.teams.status(first.id).state).toBe("completed"), { timeout: 15000 });
    await call("orchestration.send", { threadId: thread.id, text: "@Assistant General what do you think of the plan?", requestKey: "ask-assistant" });
    const second = teamRuntime.activeForThread(core.db, thread.id)!;
    const assistant = await liveRun(second.id, "member:assistant");
    expect(core.teams.status(second.id).actors.map((actor) => [actor.id, actor.state])).toEqual([
      ["lead", "waiting"],
      ["member:assistant", "running"],
      ["member:mark", "waiting"],
    ]);
    endTurn(assistant, "Solid, but @mark should own the routing.");
    // A colleague's mention is Mark's to read, not to answer; only team_say from that turn would be public.
    const mark = await liveRun(second.id, "member:mark");
    expect(mark.spec.prompt).toContain("Assistant General to Mark (to you): Solid, but @mark should own the routing.");
    expect(mark.spec.prompt).toContain("AMBIENT TURN");
    endTurn(mark, "On it.");
    await vi.waitFor(() => expect(core.teams.status(second.id).state).toBe("completed"), { timeout: 15000 });
    await call("orchestration.send", { threadId: thread.id, text: "@everyone status please", requestKey: "status-all" });
    const third = teamRuntime.activeForThread(core.db, thread.id)!;
    const all = await Promise.all(["lead", "member:assistant", "member:mark"].map((id) => liveRun(third.id, id)));
    for (const run of all) endTurn(run, "Status: fine.");
    await vi.waitFor(() => expect(core.teams.status(third.id).state).toBe("completed"), { timeout: 15000 });
    // A plain message still goes to the lead alone.
    await call("orchestration.send", { threadId: thread.id, text: "Thanks all, wrap up", requestKey: "wrap" });
    const fourth = teamRuntime.activeForThread(core.db, thread.id)!;
    await liveRun(fourth.id, "lead");
    expect(core.teams.status(fourth.id).actors.map((actor) => [actor.id, actor.state])).toEqual([
      ["lead", "running"],
      ["member:assistant", "waiting"],
      ["member:mark", "waiting"],
    ]);
  });
});
