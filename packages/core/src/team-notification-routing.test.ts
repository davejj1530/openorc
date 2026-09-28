import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { orchestration, projects, settings, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { inheritedProbe } from "./services/shell-environment.js";

interface Turn {
  spec: RunSpec;
  handle: RunHandle;
  exited: boolean;
}
let core: OpenOrc, directory: string, project: Project, pushed: CorePush[], turns: Map<string, Turn>;
const notices = () => pushed.filter((message): message is Extract<CorePush, { type: "notify" }> => message.type === "notify");
// Restart coverage needs a disk database, not the developer's login shell.
const open = () => OpenOrc.create({ dataDir: path.join(directory, "data"), shellProbe: inheritedProbe(), transport: { push: (message) => pushed.push(message) } });
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-notification-routing-"));
  const root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "qa@example.com"]);
  await git(root, ["config", "user.name", "QA"]);
  await writeFile(path.join(root, "README.md"), "# Notifications\n");
  await commitAll(root, "Fixture");
  turns = new Map();
  pushed = [];
  const start = (spec: RunSpec) => {
    let resolve!: (code: number) => void;
    const done = new Promise<number>((next) => {
      resolve = next;
    });
    const turn: Turn = {
      spec,
      exited: false,
      handle: new RunHandle(spec.runId, {
        done,
        send: async () => {},
        interrupt() {},
        close() {
          if (turn.exited) return;
          turn.exited = true;
          turn.handle.emit("exit", 0);
          resolve(0);
        },
      }),
    };
    turns.set(spec.runId, turn);
    return turn.handle;
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(start);
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(start);
  core = await open();
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
});
afterEach(async () => {
  if (core) await core.close();
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function tool(turn: Turn, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch((await core.mcpServer()).urlForRun(turn.spec.runId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(10000),
  });
  const raw = await response.text();
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
  );
  if (payload.error || payload.result.isError) throw Error(JSON.stringify(payload));
  return JSON.parse(payload.result.content[0].text);
}
function active(executionId: string, actorId = "lead"): Turn {
  const runId = core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.runId)?.runId;
  if (!runId || !turns.has(runId)) throw Error("Missing scripted run");
  return turns.get(runId)!;
}
async function finish(turn: Turn, executionId: string, failed = false) {
  const { runId, agent, model } = turn.spec;
  turn.handle.emit("event", { type: "session.started", runId, agent, model: model ?? "fixture", externalSessionId: `session-${runId}`, ts: Date.now() });
  turn.handle.emit("event", {
    type: "turn.completed",
    runId,
    turnId: runId,
    status: failed ? "error" : "success",
    resultText: failed ? "Fixture failure" : "Fixture result",
    durationMs: 1,
    ts: Date.now(),
  });
  await vi.waitFor(() => expect(core.teams.status(executionId).attempts.find((attempt) => attempt.runId === runId)?.state).toBe("closed"), { timeout: 10000 });
  await core.teams.drain();
}
async function startTeam() {
  const config = (agent: "codex" | "claude") => ({ agent, model: "fixture", effort: null, fastMode: false });
  const thread = threads.insert(core.db, { projectId: project.id, title: "Notification team", ...config("codex"), mode: "act", permissionMode: "trusted" });
  const team = orchestration.save(core.db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Team",
      limits: DEFAULT_TEAM_LIMITS,
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: config("codex") },
        { key: "one", name: "Engineer", managerKey: "lead", responsibility: "Build", settings: config("claude") },
        { key: "two", name: "Reviewer", managerKey: "lead", responsibility: "Review", settings: config("codex") },
      ],
    },
  });
  const execution = await core.teams.start({ threadId: thread.id, teamRevisionId: team.revision.id, prompt: "Coordinate notifications" });
  await core.teams.drain();
  return { thread, executionId: execution.id, lead: active(execution.id) };
}
async function workers(executionId: string, lead: Turn) {
  for (const key of ["one", "two"]) await tool(lead, "task_create", { execution: "delegate", member_key: key, request_key: key, title: `Work ${key}`, spec: "Complete this isolated assignment" });
  const children = core.teams.status(executionId).actors.filter((actor) => actor.parentId === "lead" && !actor.participant);
  await tool(lead, "team_wait", { assignment_ids: children.map((actor) => actor.id) });
  await finish(lead, executionId);
  return children.map((actor) => ({ actor, turn: active(executionId, actor.id) }));
}
describe("team notification wiring through core and MCP", () => {
  it("reports scoped host approval/question requests and final aggregate completion, without per-turn completion spam", async () => {
    const { thread, executionId, lead } = await startTeam();
    const children = await workers(executionId, lead);
    expect(notices()).toEqual([]);
    const requests = children.map(({ turn }, index) =>
      tool(turn, "approve", {
        tool_use_id: "same-provider-id",
        tool_name: index ? "AskUserQuestion" : "Bash",
        input: index ? { questions: [{ question: "Which approach?" }] } : { command: "echo check" },
      }),
    );
    await vi.waitFor(() => expect(notices()).toHaveLength(2));
    expect(
      notices()
        .map((n) => n.kind)
        .sort(),
    ).toEqual(["approval", "question"]);
    expect(new Set(notices().map((n) => n.id)).size).toBe(2);
    for (const { actor, turn } of children) {
      expect(notices()).toContainEqual(expect.objectContaining({ threadId: thread.id, taskId: actor.taskId, executionId, actorId: actor.id, runId: turn.spec.runId, approvalId: "same-provider-id" }));
      core.runs.resolveApproval(turn.spec.runId, "same-provider-id", "allow", { approach: ["A"] });
    }
    await Promise.all(requests);
    for (const { turn } of children) {
      await tool(turn, "team_complete", { result: "Worker complete" });
      await finish(turn, executionId);
    }
    expect(notices().filter((n) => n.kind === "finished" || n.kind === "task")).toEqual([]);
    const final = active(executionId);
    await tool(final, "team_complete", { result: "The complete team result" });
    await finish(final, executionId);
    expect(notices().filter((n) => n.kind === "finished")).toEqual([expect.objectContaining({ id: `finished:${executionId}`, threadId: thread.id, taskId: null, body: "The complete team result" })]);
    await core.teams.stop(executionId);
    expect(notices()).toHaveLength(3);
  });
  it("reports attention once and preserves receipts without shutdown/startup replay", async () => {
    const { executionId, lead } = await startTeam();
    await finish(lead, executionId, true);
    expect(notices()).toEqual([expect.objectContaining({ kind: "error", executionId, actorId: "lead" })]);
    const before = notices().length;
    await core.close();
    expect(notices()).toHaveLength(before);
    core = await open();
    expect(core.teams.status(executionId).state).toBe("attention");
    expect(notices()).toHaveLength(before);
  });
});
