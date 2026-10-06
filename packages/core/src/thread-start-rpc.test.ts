import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { projects, settings, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { CorePush, ModelOption, Project, RpcMethod, RpcParams, RpcResults, RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { MAX_WORKING_CHILDREN, pickModel } from "./services/thread-agent-tools.js";

let core: OpenOrc;
let folder: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;
let rpcId = 0;

const model = (id: string, label: string): ModelOption => ({ id, label, agent: "codex", isDefault: false, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } });

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-thread-start-"));
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
      send: async () => undefined,
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
  const root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await commitAll(root, "Fixture baseline");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.runs, "models").mockResolvedValue([model("fixture-codex", "Scripted provider"), model("gpt-6.1-sol", "GPT-6.1 Sol"), model("gpt-6.1-mini", "GPT-6.1 Mini")]);
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

type Started = { thread: { id: string; title: string }; agent: string; model: string | null; message: string };

async function startThread(runId: string, args: Record<string, unknown>): Promise<Started> {
  const url = (await core.mcpServer()).urlForRun(runId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "thread_start", arguments: args } }),
    signal: AbortSignal.timeout(8000),
  });
  const raw = await response.text();
  const line = raw.startsWith("{")
    ? raw
    : raw
        .split("\n")
        .find((entry) => entry.startsWith("data: "))!
        .slice(6);
  const payload = JSON.parse(line) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result?.isError) throw new Error(payload.result.content[0]?.text);
  return JSON.parse(payload.result!.content[0]!.text) as Started;
}

async function parent(input: Partial<RpcParams<"threads.start">> = {}) {
  const started = await call("threads.start", {
    projectId: project.id,
    agent: "codex",
    model: "fixture-codex",
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
    prompt: "Build the landing page",
    ...input,
  });
  return { thread: started.thread, runId: started.run!.id };
}

/** The spec of the first run of a thread, once its provider has started. */
async function firstSpec(threadId: string): Promise<RunSpec> {
  let spec: RunSpec | undefined;
  await vi.waitFor(() => {
    spec = [...turns.values()].find(({ spec: candidate }) => core.db.stmt("SELECT thread_id FROM runs WHERE id = ?").get(candidate.runId)?.thread_id === threadId)?.spec;
    expect(spec).toBeTruthy();
  });
  return spec!;
}

function endTurn(runId: string) {
  const { handle } = turns.get(runId)!;
  handle.emit("event", { type: "message.completed", runId, role: "assistant", messageId: `reply-${runId}`, text: "Done", ts: Date.now() });
  handle.emit("event", { type: "turn.completed", runId, turnId: `turn-${runId}`, status: "success", durationMs: 1, ts: Date.now() });
}

it("starts a thread beside its parent, in its checkout with its settings, and tells it who to talk to", async () => {
  const { thread: home, runId } = await parent();
  const started = await startThread(runId, { prompt: "Generate the hero assets", title: "Hero assets" });
  const child = threads.get(core.db, started.thread.id)!;
  expect(child).toMatchObject({ parentThreadId: home.id, title: "Hero assets", agent: "codex", model: "fixture-codex", mode: "act", permissionMode: "trusted", workspaceMode: "current" });
  const [own, theirs] = await Promise.all([firstSpec(home.id), firstSpec(child.id)]);
  expect(theirs.cwd).toBe(own.cwd);
  expect(theirs.prompt).toContain(`"Build the landing page" (id ${home.id}) started this thread`);
  expect(theirs.prompt).toContain("Generate the hero assets");
  expect(started.message).toMatch(/thread_send/);
});

it("joins the parent's worktree and leaves it standing when the started thread goes", async () => {
  const { thread: home, runId } = await parent({ workspaceMode: "worktree" });
  const worktree = threads.get(core.db, home.id)!.worktreePath!;
  expect(worktree).toBeTruthy();
  const started = await startThread(runId, { prompt: "Write the copy" });
  expect(threads.get(core.db, started.thread.id)).toMatchObject({ workspaceMode: "worktree", worktreePath: worktree });
  expect(started.thread.title).toBe("Write the copy");
  expect((await firstSpec(started.thread.id)).cwd).toBe((await firstSpec(home.id)).cwd);
  // Like any shared folder, it can't be cleared away while the parent is mid-turn in it.
  endTurn(runId);
  await vi.waitFor(() => expect(core.runs.threadActivity(home.id)).toBe("idle"));
  await call("threads.delete", { id: started.thread.id });
  await expect(access(worktree)).resolves.toBeUndefined();
  expect(threads.get(core.db, home.id)?.worktreePath).toBe(worktree);
});

it("finds a model by the name the user gave it, and answers a name it can't place with the choices", async () => {
  const { runId } = await parent();
  const started = await startThread(runId, { prompt: "Generate assets", agent: "codex", model: "codex 6.1 sol" });
  expect(threads.get(core.db, started.thread.id)?.model).toBe("gpt-6.1-sol");
  const options = await core.runs.models("codex");
  expect(() => pickModel(options, "codex", "6.1")).toThrow(/fits several codex models.*GPT-6.1 Sol \(gpt-6.1-sol\)/);
  expect(() => pickModel(options, "codex", "7.0 ultra")).toThrow(/No codex model is called "7.0 ultra"/);
  await expect(startThread(runId, { prompt: "Generate assets", model: "7.0 ultra" })).rejects.toThrow(/Choose one of/);
});

it(`keeps ${MAX_WORKING_CHILDREN} started threads working at once, none of their own, and none from Plan mode`, async () => {
  const { runId } = await parent();
  const children: Started[] = [];
  for (let index = 0; index < MAX_WORKING_CHILDREN; index++) children.push(await startThread(runId, { prompt: `Part ${index + 1}` }));
  await expect(startThread(runId, { prompt: "One more" })).rejects.toThrow(/still working/);
  const first = await firstSpec(children[0]!.thread.id);
  await expect(startThread(first.runId, { prompt: "A grandchild" })).rejects.toThrow(/can't start its own/);
  endTurn(first.runId);
  await vi.waitFor(() => expect(core.runs.threadActivity(children[0]!.thread.id)).toBe("idle"));
  await expect(startThread(runId, { prompt: "One more" })).resolves.toMatchObject({ thread: { title: "One more" } });
  const planning = await parent({ mode: "plan", prompt: "Think it through" });
  await expect(startThread(planning.runId, { prompt: "Do it" })).rejects.toThrow(/Plan mode/);
});
