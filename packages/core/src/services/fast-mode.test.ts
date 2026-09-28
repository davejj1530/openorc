import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle, type AgentLaunchEnvironment } from "@openorc/agents";
import { threads, runs } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { CorePush, Project, RpcMethod, RpcParams, RpcResults, RunSpec, SystemInfo } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const pushed: CorePush[] = [];
let requestId = 0;
async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++requestId;
  await core.handle({ type: "rpc", id, method, params });
  const reply = pushed.find((m) => (m.type === "rpc.result" || m.type === "rpc.error") && m.id === id);
  if (!reply || reply.type !== "rpc.result") throw new Error(reply?.type === "rpc.error" ? reply.message : "Missing RPC reply");
  return reply.result as RpcResults[M];
}
const models = [
  {
    id: "fixture-fast",
    model: "fixture-fast",
    displayName: "Fast fixture",
    description: "",
    isDefault: true,
    hidden: false,
    efforts: ["medium", "high"],
    defaultEffort: "medium",
    serviceTiers: [{ id: "priority", name: "Fast", description: "Higher usage" }],
  },
  { id: "fixture-standard", model: "fixture-standard", displayName: "Standard fixture", description: "", isDefault: false, hidden: false, efforts: [], defaultEffort: null, serviceTiers: [] },
];
const info = (version: string): SystemInfo => ({
  dataDir,
  harnesses: [
    { id: "codex", state: "ready", path: "fixture", version: "fixture", revision: 0 },
    { id: "claude", state: "ready", path: "fixture", version, revision: 0 },
  ],
  gh: { installed: false, path: null },
});

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-fast-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-fast-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: (m) => pushed.push(m) } });
  project = await core.projects.import(root);
  const discovery = vi.spyOn(CodexAdapter.prototype, "listModels").mockResolvedValue(models);
  await core.runs.models("codex");
  discovery.mockRestore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await core.environment.refresh();
});
afterAll(async () => {
  await core?.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function session(spec: RunSpec, _launch: AgentLaunchEnvironment) {
  let finish!: (code: number) => void;
  let closed = false;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const handle = new RunHandle(spec.runId, {
    send: async () => {},
    interrupt() {},
    close() {
      if (closed) return;
      closed = true;
      handle.emit("exit", 0);
      finish(0);
    },
    done,
  });
  return handle;
}

async function cacheFixtureCodexModels(): Promise<void> {
  const discovery = vi.spyOn(CodexAdapter.prototype, "listModels").mockResolvedValue(models);
  await core.runs.models("codex");
  discovery.mockRestore();
}

describe("Fast mode eligibility", () => {
  it("requires a current Claude CLI and eligible Opus without switching the model", async () => {
    const system = vi.spyOn(core.system, "infoFor").mockResolvedValue(info("2.1.33"));
    await expect(core.runs.validateFastMode("claude", "claude-opus-5", true)).rejects.toThrow("2.1.219");
    system.mockResolvedValue(info("2.1.219"));
    await core.environment.refresh();
    await expect(core.runs.validateFastMode("claude", "claude-opus-5", true)).resolves.toBeUndefined();
    await expect(core.runs.validateFastMode("claude", "claude-sonnet-5", true)).rejects.toThrow("not offered for this model");
    await expect(core.runs.validateFastMode("claude", "claude-sonnet-5", false)).resolves.toBeUndefined();
    vi.stubEnv("CLAUDE_CODE_DISABLE_FAST_MODE", "1");
    await core.environment.refresh();
    await expect(core.runs.validateFastMode("claude", "claude-opus-5", true)).rejects.toThrow("disabled by your environment");
  });

  it("lists ultracode after Max only on a Claude Code that takes the flag", async () => {
    const system = vi.spyOn(core.system, "infoFor").mockResolvedValue(info("2.1.277"));
    const older = await core.runs.models("claude");
    expect(older.some((m) => m.efforts.includes("ultracode"))).toBe(false);
    system.mockResolvedValue(info("2.1.278"));
    await core.environment.refresh();
    const current = await core.runs.models("claude");
    // Ultracode rides on xhigh, so older generations without that level keep their shorter ladder.
    const withXhigh = current.filter((m) => m.efforts.includes("xhigh"));
    expect(withXhigh.map((m) => m.efforts.slice(-2))).toEqual(withXhigh.map(() => ["max", "ultracode"]));
    expect(current.filter((m) => !m.efforts.includes("xhigh")).map((m) => [m.id, m.legacy, m.efforts.at(-1)])).toEqual([
      ["claude-opus-4-6", true, "max"],
      ["claude-opus-4-5", true, "high"],
      ["claude-sonnet-4-6", true, "max"],
    ]);
  });

  it.each(["CLAUDE_CODE_USE_FOUNDRY"])("respects %s", async (key) => {
    vi.spyOn(core.system, "infoFor").mockResolvedValue(info("2.1.219"));
    vi.stubEnv(key, "1");
    await core.environment.refresh();
    await expect(core.runs.validateFastMode("claude", "claude-opus-5", true)).rejects.toThrow("requires the Anthropic API");
  });
});

describe("Fast mode persistence and delivery", () => {
  it.each(["codex", "claude"] as const)("carries %s Fast through start, fork, and a resumed Standard turn", async (agent) => {
    if (agent === "codex") await cacheFixtureCodexModels();
    vi.spyOn(core.system, "infoFor").mockResolvedValue(info("2.1.219"));
    const adapter = vi.spyOn(agent === "codex" ? CodexAdapter.prototype : ClaudeAdapter.prototype, "start").mockImplementation(session);
    const model = agent === "codex" ? "fixture-fast" : "claude-opus-5";
    const { thread, run } = await call("threads.start", {
      projectId: project.id,
      agent,
      model,
      effort: "high",
      fastMode: true,
      mode: "act",
      permissionMode: "trusted",
      prompt: "First",
      attachments: undefined,
      title: "Fast fixture",
    });
    if (!run) throw new Error("A model launch must return its run.");
    expect(thread.fastMode).toBe(true);
    expect(run.fastMode).toBe(true);
    expect(runs.get(core.db, run.id)?.fastMode).toBe(true);
    expect(adapter.mock.calls[0]?.[0]).toMatchObject({ model, effort: "high", fastMode: true });
    core.runs.close(run.id);
    await vi.waitFor(() => expect(core.runs.liveRunForThread(thread.id)).toBeNull());
    const fork = await core.threads.fork(thread.id);
    expect(fork.fastMode).toBe(true);
    vi.spyOn(core.threads, "onTaskRunFinished").mockResolvedValue(undefined);
    const { task } = await core.threads.spawnTask(thread, { title: `Inherited ${agent} task`, spec: "Fixture only", execution: "backlog" }, "user");
    await core.threads.startTask(task, undefined, "current");
    expect(adapter.mock.lastCall?.[0]).toMatchObject({ model, fastMode: true });
    const taskRun = core.runs.liveRunForTask(task.id);
    expect(taskRun?.fastMode).toBe(true);
    if (taskRun) core.runs.close(taskRun.id);
    const next = await call("runs.start", { threadId: thread.id, agent, model, effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", prompt: "Standard", attachments: undefined });
    expect(next.fastMode).toBe(false);
    expect(threads.get(core.db, thread.id)?.fastMode).toBe(false);
    expect(adapter.mock.lastCall?.[0].fastMode).toBe(false);
    core.runs.close(next.id);
  });

  it("applies a speed change to queued input only after the current turn finishes", async () => {
    await cacheFixtureCodexModels();
    const handles: RunHandle[] = [];
    const adapter = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec, launch) => {
      const handle = session(spec, launch);
      handles.push(handle);
      return handle;
    });
    const { thread, run } = await core.threads.start({
      projectId: project.id,
      agent: "codex",
      model: "fixture-fast",
      effort: "medium",
      fastMode: false,
      mode: "act",
      permissionMode: "trusted",
      prompt: "First",
      attachments: undefined,
      title: "Queue fixture",
    });
    handles[0]!.emit("event", { type: "session.started", runId: run.id, ts: Date.now(), agent: "codex", externalSessionId: "existing", model: "fixture-fast" });
    await call("threads.update", { id: thread.id, patch: { fastMode: true } });
    core.threads.queue(thread.id, "Faster next turn");
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(runs.get(core.db, run.id)?.fastMode).toBe(false);
    handles[0]!.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "first", status: "success", durationMs: 0 });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(2));
    expect(adapter.mock.lastCall?.[0]).toMatchObject({ fastMode: true, resumeSessionId: "existing", prompt: "Faster next turn", effort: "medium" });
    await vi.waitFor(() => expect(core.threads.get(thread.id)?.queued).toHaveLength(0));
    handles[1]!.close();
  });
});
