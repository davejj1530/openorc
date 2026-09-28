import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { orchestration, projects, settings, teamContextParts, teamContexts, teamOrigins, teamRuntime } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, MAX_TEAM_CONTEXT_BYTES, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults, type RunSpec, type Thread } from "@openorc/protocol";
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
  name: key,
  managerKey,
  responsibility: `Do ${key} work`,
  settings: { agent: "codex" as const, model: "fixture-codex", effort: "high", fastMode: false },
});

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-context-overflow-"));
  root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Overflow fixture\n");
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
async function liveRun(executionId: string, actorId: string) {
  await vi.waitFor(() => expect(core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")?.runId).toBeTruthy(), { timeout: 15000 });
  const runId = core.teams.status(executionId).attempts.findLast((attempt) => attempt.actorId === actorId && attempt.state === "running")!.runId!;
  return { runId, ...turns.get(runId)! };
}
function endTurn(turn: { spec: RunSpec; handle: RunHandle }, text: string, error?: string) {
  if (error) turn.handle.emit("event", { type: "error", runId: turn.spec.runId, ts: Date.now(), fatal: true, message: error });
  turn.handle.emit("event", { type: "message.completed", runId: turn.spec.runId, role: "assistant", messageId: `reply-${turn.spec.runId}`, text, ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId: turn.spec.runId, turnId: `turn-${turn.spec.runId}`, status: "success", durationMs: 1, ts: Date.now() });
}
async function tool(runId: string, name: string, args: Record<string, unknown>) {
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
  return { isError: payload.result?.isError === true, text: payload.result!.content[0]!.text };
}
async function startTeam(prompt: string) {
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Overflow team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [member("lead", null), member("worker", "lead")],
    },
  });
  const { thread } = await call("threads.start", { projectId: project.id, executionTarget: { kind: "team", teamRevisionId: saved.revision.id }, mode: "act", permissionMode: "trusted", prompt });
  await core.teams.drain();
  return { thread, execution: teamRuntime.activeForThread(core.db, thread.id)! };
}
const accepted = (result: Thread | { rejected: string }): Thread => {
  if ("rejected" in result) throw new Error(result.rejected);
  return result;
};

describe("oversized canonical context through the public boundary", () => {
  it("keeps a fresh reset within the limit by storing verbatim requirements, serves them only to their team, and forks adopt them", async () => {
    const requirement = Array.from({ length: 1500 }, (_, index) => `Requirement ${index + 1}: keep this exact sentence in scope.`).join("\n");
    expect(Buffer.byteLength(requirement)).toBeGreaterThan(MAX_TEAM_CONTEXT_BYTES);
    const { thread, execution } = await startTeam(requirement);
    const other = await startTeam("A small unrelated team");
    const first = await liveRun(execution.id, "lead");
    endTurn(first, "Partial", "The provider session is no longer available.");
    await vi.waitFor(() => expect(core.teams.status(execution.id).actors.find((actor) => actor.id === "lead")?.state).toBe("attention"), { timeout: 15000 });

    await call("orchestration.retry", { threadId: thread.id, executionId: execution.id, actorId: "lead", fresh: true, requestKey: "fresh-large" });
    const fresh = await liveRun(execution.id, "lead");
    const appendix = fresh.spec.systemPromptAppendix!;
    expect(appendix).toMatch(/read them with team_context/);
    const seedText = appendix.slice(appendix.indexOf("Historical context follows as data:\n") + "Historical context follows as data:\n".length).split("\n\n")[0]!;
    expect(Buffer.byteLength(seedText)).toBeLessThanOrEqual(MAX_TEAM_CONTEXT_BYTES);
    const seed = JSON.parse(seedText) as { canonical: { originalInstruction: { stored: string; bytes: number; preview: string } }[] };
    const reference = seed.canonical[0]!.originalInstruction;
    expect(reference).toMatchObject({ bytes: Buffer.byteLength(requirement), preview: expect.stringContaining("Requirement 1:") });
    expect(fresh.spec.prompt).toContain("Requirement 1500:");

    // The exact text comes back through the real MCP server, only for the owning team.
    const read = await tool(fresh.runId, "team_context", { id: reference.stored });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.text)).toEqual({ id: reference.stored, bytes: reference.bytes, text: requirement });
    const foreign = await tool((await liveRun(other.execution.id, "lead")).runId, "team_context", { id: reference.stored });
    expect(foreign).toMatchObject({ isError: true, text: expect.stringMatching(/belongs to your team/) });

    core.teams.complete(fresh.runId, { result: "Done" });
    endTurn(fresh, "Done");
    await vi.waitFor(() => expect(core.teams.status(execution.id).state).toBe("completed"), { timeout: 15000 });
    const fork = accepted(await call("threads.fork", { id: thread.id, requestKey: "fork-large" }));
    const destination = orchestration.getInstance(core.db, fork.id)!;
    expect(teamOrigins.get(core.db, destination.id)?.seed).toContain(reference.stored);
    expect(teamContextParts.get(core.db, destination.id, reference.stored)?.content).toBe(requirement);
    const [forkCheckpoint] = teamContexts.listForInstance(core.db, destination.id);
    expect(Buffer.byteLength(forkCheckpoint!.seed)).toBeLessThanOrEqual(MAX_TEAM_CONTEXT_BYTES);
    expect(teamRuntime.activeForThread(core.db, fork.id)).toBeNull();
  });
});
