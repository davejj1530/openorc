import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, settings, teamRuntime, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let folder: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let sends: { runId: string; text: string }[];
let rpcId = 0;
const member = (key: string, managerKey: string | null) => ({
  key,
  name: key,
  managerKey,
  responsibility: `Do ${key} work`,
  settings: { agent: "codex" as const, model: "fixture-codex", effort: "high", fastMode: false },
});

async function repository(name: string) {
  const root = path.join(folder, name);
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), `# ${name}\n`);
  await commitAll(root, "Fixture baseline");
  return root;
}
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-messaging-"));
  pushed = [];
  turns = new Map();
  sends = [];
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let close!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      close = resolve;
    });
    let closed = false;
    const handle = new RunHandle(spec.runId, {
      done,
      send: async (text) => {
        sends.push({ runId: spec.runId, text });
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
  });
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: await repository("repository"), defaultBranch: "main", gitRemote: null, settings: {} });
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
  return JSON.parse(payload.result!.content[0]!.text) as { delivered: boolean; message: string };
}
async function startTeam(prompt: string, name = "Messaging team") {
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name, limits: { ...DEFAULT_TEAM_LIMITS }, discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] }, members: [member("lead", null)] },
  });
  const { thread } = await call("threads.start", { projectId: project.id, executionTarget: { kind: "team", teamRevisionId: saved.revision.id }, mode: "act", permissionMode: "trusted", prompt });
  await core.teams.drain();
  const execution = teamRuntime.activeForThread(core.db, thread.id)!;
  await vi.waitFor(() => expect(core.teams.status(execution.id).attempts.findLast((attempt) => attempt.actorId === "lead" && attempt.state === "running")?.runId).toBeTruthy(), { timeout: 15000 });
  return { thread, execution, runId: core.teams.status(execution.id).attempts.findLast((attempt) => attempt.actorId === "lead" && attempt.state === "running")!.runId! };
}
const leadMessages = (executionId: string) => core.teams.status(executionId).messages.filter((message) => message.recipientId === "lead" && message.kind === "direction");
function endTurn(runId: string, text: string) {
  const turn = turns.get(runId)!;
  turn.handle.emit("event", { type: "message.completed", runId, role: "assistant", messageId: `reply-${runId}`, text, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId, turnId: `turn-${runId}`, status: "success", durationMs: 1, ts: Date.now() });
}

describe("same-project cross-thread messaging", () => {
  it("blocks Plan messages into an acting team and caps agent-only chains across teams", async () => {
    const team = await startTeam("Coordinate safely");
    const solo = await call("threads.start", {
      projectId: project.id,
      agent: "codex",
      model: "fixture-codex",
      mode: "plan",
      permissionMode: "trusted",
      workspaceMode: "current",
      prompt: "Plan only",
    });
    expect(await mcpCall(solo.run!.id, "thread_send", { id: team.thread.id, text: "Implement this now" })).toMatchObject({ delivered: false, message: /Plan mode/ });
    expect(leadMessages(team.execution.id)).toHaveLength(0);
    const other = await startTeam("Other work", "Other team");
    core.runs.noteAgentMessage(other.thread.id, 3);
    const input = { id: team.thread.id, text: "Fourth hop", request_key: "hop-four" };
    expect(await mcpCall(other.runId, "thread_send", input)).toMatchObject({ delivered: true });
    expect(core.runs.agentChain(team.thread.id)).toBe(4);
    expect(await mcpCall(team.runId, "thread_send", { id: other.thread.id, text: "Fifth hop" })).toMatchObject({ delivered: false, message: /limit is 4/ });
    expect(await mcpCall(other.runId, "thread_send", input)).toMatchObject({ delivered: true });
    expect(await mcpCall(other.runId, "thread_send", { ...input, text: "Different work with the same key" })).toMatchObject({ delivered: false, message: /different message/ });
    expect(leadMessages(team.execution.id)).toHaveLength(1);
    await call("orchestration.send", { threadId: team.thread.id, text: "Continue with my direction", requestKey: "user-reset" });
    expect(core.runs.agentChain(team.thread.id)).toBe(0);
    expect(await mcpCall(team.runId, "thread_send", { id: other.thread.id, text: "After human input" })).toMatchObject({ delivered: true });
    expect(core.runs.agentChain(other.thread.id)).toBe(1);
  });

  it("asks before messaging a more permissive team and rechecks it after approval", async () => {
    const team = await startTeam("Coordinate safely");
    const solo = await call("threads.start", {
      projectId: project.id,
      agent: "codex",
      model: "fixture-codex",
      mode: "act",
      permissionMode: "review",
      workspaceMode: "current",
      prompt: "Ask before acting",
    });
    const sendWithApproval = async (key: string, decision: "allow" | "deny", changeMode = false) => {
      const sent = mcpCall(solo.run!.id, "thread_send", { id: team.thread.id, text: "Please act", request_key: key });
      await vi.waitFor(() => expect(core.runs.pending().some((approval) => approval.runId === solo.run!.id)).toBe(true));
      expect(leadMessages(team.execution.id)).toHaveLength(0);
      const approval = core.runs.pending().find((approval) => approval.runId === solo.run!.id)!;
      if (changeMode) threads.update(core.db, team.thread.id, { permissionMode: "autonomous" });
      core.runs.resolveApproval(solo.run!.id, approval.approvalId, decision);
      return sent;
    };
    expect(await sendWithApproval("denied", "deny")).toMatchObject({ delivered: false });
    expect(await sendWithApproval("changed", "allow", true)).toMatchObject({ delivered: false, message: /permissions changed/ });
    expect(await sendWithApproval("allowed", "allow")).toMatchObject({ delivered: true });
    expect(leadMessages(team.execution.id)).toHaveLength(1);
    expect(core.runs.agentChain(team.thread.id)).toBe(1);
  });

  it("queues attributed direction for a running lead, replays by key, wakes the lead in order, and answers back", async () => {
    const team = await startTeam("Coordinate the release");
    const solo = await call("threads.start", {
      projectId: project.id,
      agent: "codex",
      model: "fixture-codex",
      mode: "act",
      permissionMode: "trusted",
      workspaceMode: "current",
      prompt: "Investigate the API",
    });
    const soloRun = solo.run!.id;
    const first = await mcpCall(soloRun, "thread_send", { id: team.thread.id, text: "The API contract changed; see my notes.", request_key: "note-1" });
    expect(first).toMatchObject({ delivered: true, message: expect.stringMatching(/Queued for the lead/) });
    expect(await mcpCall(soloRun, "thread_send", { id: team.thread.id, text: "The API contract changed; see my notes.", request_key: "note-1" })).toEqual(first);
    await mcpCall(soloRun, "thread_send", { id: team.thread.id, text: "Second note without a key" });
    await mcpCall(soloRun, "thread_send", { id: team.thread.id, text: "Second note without a key" });
    const queued = leadMessages(team.execution.id);
    expect(queued.map((message) => message.senderId)).toEqual([`thread:${solo.thread.id}`, `thread:${solo.thread.id}`]);
    expect(queued[0]).toMatchObject({ state: "pending", dedupeKey: `direction:thread:${solo.thread.id}:note-1` });
    expect(queued[0]!.body).toContain(`Message from the thread "${solo.thread.title}" (id ${solo.thread.id}):\n\nThe API contract changed; see my notes.`);
    expect(queued[0]!.body).not.toContain("sent by");
    const view = (await call("orchestration.runtime", { threadId: team.thread.id }))!.executions[0]!;
    expect(view.userDirections.map((direction) => direction.from)).toEqual([
      { threadId: solo.thread.id, title: solo.thread.title },
      { threadId: solo.thread.id, title: solo.thread.title },
    ]);
    expect(view.userDirections[0]!.cancel?.allowed).toBe(false);
    // The lead yields with nothing to wait for; pending cross-thread direction wakes it in order.
    core.teams.wait(team.runId);
    endTurn(team.runId, "Waiting for input");
    await vi.waitFor(() => expect(core.teams.status(team.execution.id).attempts.filter((attempt) => attempt.actorId === "lead")).toHaveLength(2), { timeout: 15000 });
    const resumed = core.teams.status(team.execution.id).attempts.at(-1)!;
    const prompt = teamRuntime.prompt(core.db, team.execution.id, resumed.id)!;
    expect(prompt.indexOf("The API contract changed")).toBeLessThan(prompt.indexOf("Second note without a key"));
    expect(prompt).toContain(`direction from thread:${solo.thread.id}`);
    await vi.waitFor(
      () => {
        const latest = core.teams.status(team.execution.id);
        const attempt = latest.attempts.at(-1)!;
        expect([attempt.state, attempt.error, latest.actors[0]!.state, latest.error]).toEqual(["running", null, "running", null]);
      },
      { timeout: 15000 },
    );
    const resumedRunId = () => core.teams.status(team.execution.id).attempts.at(-1)!.runId!;
    await vi.waitFor(() => expect(turns.has(resumedRunId())).toBe(true), { timeout: 15000 });
    expect(leadMessages(team.execution.id).map((message) => message.state)).toEqual(["claimed", "claimed"]);
    expect(resumed.messageIds).toEqual(leadMessages(team.execution.id).map((message) => message.id));
    // The lead answers the solo thread; the live solo run receives an attributed system message.
    const reply = await mcpCall(resumedRunId(), "thread_send", { id: solo.thread.id, text: "Thanks, adjusting the plan." });
    expect(reply).toMatchObject({ delivered: true, message: expect.stringMatching(/running turn/) });
    await vi.waitFor(
      () => expect(sends.some((item) => item.runId === soloRun && item.text.includes("sent by lead of team Messaging team") && item.text.includes("Thanks, adjusting the plan."))).toBe(true),
      { timeout: 15000 },
    );
    expect(await mcpCall(resumedRunId(), "thread_send", { id: team.thread.id, text: "Talking to myself" })).toMatchObject({ delivered: false, message: /this thread/ });
    // An idle ordinary thread is never started by a team agent.
    const idle = await call("threads.start", { projectId: project.id, agent: "codex", model: "fixture-codex", mode: "act", permissionMode: "trusted", workspaceMode: "worktree", prompt: "Idle soon" });
    await core.runs.closeAndWait(idle.run!.id);
    const before = turns.size;
    expect(await mcpCall(resumedRunId(), "thread_send", { id: idle.thread.id, text: "Wake up" })).toMatchObject({ delivered: false, message: /idle.*roster/ });
    expect(turns.size).toBe(before);
    endTurn(resumedRunId(), "Handled the notes");
    await vi.waitFor(() => expect(leadMessages(team.execution.id).map((message) => message.state)).toEqual(["delivered", "delivered"]), { timeout: 15000 });
  });

  it("routes team-to-team messages to the other lead, refuses idle teams, other projects and deleted owners, and supports the user relay", async () => {
    const a = await startTeam("Team A work", "Team A");
    const b = await startTeam("Team B work", "Team B");
    const toB = await mcpCall(a.runId, "thread_send", { id: b.thread.id, text: "Team A here: the shared module is frozen." });
    expect(toB.delivered).toBe(true);
    const message = leadMessages(b.execution.id)[0]!;
    expect(message.senderId).toBe(`thread:${a.thread.id}`);
    expect(message.body).toContain(`(id ${a.thread.id}) sent by lead of team Team A:`);
    await call("threads.send", { id: b.thread.id, text: "Relayed by the user from A", fromThreadId: a.thread.id });
    expect(leadMessages(b.execution.id)).toHaveLength(2);
    expect(leadMessages(b.execution.id)[1]!.body).not.toContain("sent by");
    await call("orchestration.stop", { threadId: b.thread.id, executionId: b.execution.id });
    const executions = () => (core.db.stmt("SELECT COUNT(*) AS n FROM team_executions WHERE thread_id=?").get(b.thread.id) as { n: number }).n;
    expect(await mcpCall(a.runId, "thread_send", { id: b.thread.id, text: "Too late" })).toMatchObject({ delivered: false, message: /not running/ });
    await expect(call("threads.send", { id: b.thread.id, text: "Relay too late", fromThreadId: a.thread.id })).rejects.toThrow(/not running/);
    expect(executions()).toBe(1);
    const other = projects.insert(core.db, { name: "Other", rootPath: await repository("other"), defaultBranch: "main", gitRemote: null, settings: {} });
    const foreign = threads.insert(core.db, { projectId: other.id, title: "Foreign", agent: "codex", model: "fixture-codex", effort: "high", mode: "act", permissionMode: "trusted" });
    expect(await mcpCall(a.runId, "thread_send", { id: foreign.id, text: "Across projects" })).toMatchObject({ delivered: false, message: /No such thread/ });
    expect(await mcpCall(a.runId, "thread_send", { id: "missing", text: "Nowhere" })).toMatchObject({ delivered: false, message: /No such thread/ });
    // A stopped taskless team can be deleted; a deleted owner is no longer addressable.
    expect(await call("threads.delete", { id: b.thread.id, requestKey: "delete-b" })).toBeNull();
    expect(await mcpCall(a.runId, "thread_send", { id: b.thread.id, text: "Gone" })).toMatchObject({ delivered: false, message: /No such thread/ });
  });
});
