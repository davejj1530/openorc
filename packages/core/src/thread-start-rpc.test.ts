import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { claudeAccounts, memories, projects, runs, settings, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, THREAD_EXISTS, type ModelOption, type Project, type RpcParams, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { pickModel } from "./services/thread-agent-tools.js";
import { rpcClient } from "./rpc-test-client.js";

let core: OpenOrc;
let folder: string;
let project: Project;
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;

const model = (id: string, label: string, fast = false): ModelOption => ({
  id,
  label,
  agent: "codex",
  isDefault: false,
  efforts: ["high", "max"],
  defaultEffort: "high",
  fastMode: { supported: fast },
});

/** A provider that answers only when the test says so. */
function scripted(spec: RunSpec): RunHandle {
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
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-thread-start-"));
  turns = new Map();
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(scripted);
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: () => {} } });
  settings.set(core.db, "extraction.provider", "off");
  const root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await commitAll(root, "Fixture baseline");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.runs, "models").mockResolvedValue([
    model("fixture-codex", "Scripted provider"),
    model("gpt-6.1-sol", "GPT-6.1 Sol"),
    model("gpt-6.1-mini", "GPT-6.1 Mini"),
    model("gpt-6-astra", "GPT-6 Astra", true),
  ]);
  // An ended turn names its thread; a real titler would still be running when the core closes.
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
});
afterEach(async () => {
  if (core) await core.close();
  vi.restoreAllMocks();
  if (folder) await rm(folder, { recursive: true, force: true });
});

const call = rpcClient(() => core);

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

it("starts a thread under the id its owner chose, and refuses that id once it is taken", async () => {
  const named = { id: "5b0e7a52-1c3f-4d8e-9a6b-2f4c8e1d7a90", projectId: project.id, agent: "codex", model: "fixture-codex", mode: "act", permissionMode: "autonomous", prompt: "Named" } as const;
  const { thread } = await call("threads.start", named);
  expect(thread.id).toBe(named.id);
  await expect(call("threads.start", { ...named, prompt: "Again" })).rejects.toThrow(THREAD_EXISTS);
  expect(threads.list(core.db, { projectId: project.id }).filter((each) => each.id === named.id)).toHaveLength(1);
});

it("deletes a finished thread while another thread is running in the main checkout", async () => {
  const working = await parent();
  const question = await parent({ prompt: "What does this project do?" });
  endTurn(question.runId);
  await vi.waitFor(() => expect(core.runs.threadActivity(question.thread.id)).toBe("idle"));
  const draft = path.join(project.rootPath, "draft.txt");
  await writeFile(draft, "Work in progress\n");

  await call("threads.delete", { id: question.thread.id });
  expect(threads.get(core.db, question.thread.id)).toBeNull();
  expect(core.runs.isLive(question.runId)).toBe(false);
  expect(core.runs.threadActivity(working.thread.id)).toBe("running");
  expect(await readFile(draft, "utf8")).toBe("Work in progress\n");
  endTurn(working.runId);
  await vi.waitFor(async () => expect(await call("threads.checkpoints", { id: working.thread.id })).toHaveLength(1));
});

it("keeps a thread while its own provider is starting in the main checkout", async () => {
  const server = await core.mcpServer();
  let connect!: () => void;
  const connecting = vi.spyOn(core, "mcpServer").mockReturnValueOnce(
    new Promise((resolve) => {
      connect = () => resolve(server);
    }),
  );
  const id = "82c5d658-aaf0-4393-85cf-a1199655b720";
  const starting = parent({ id });
  try {
    await vi.waitFor(() => expect(connecting).toHaveBeenCalled());
    await expect(call("threads.delete", { id })).rejects.toThrow(/starting/);
  } finally {
    connect();
    await starting;
  }
  expect(core.runs.threadActivity(id)).toBe("running");
});

it("keeps a dedicated worktree until another writer releases it", async () => {
  const { thread } = await parent({ workspaceMode: "worktree" });
  const worktree = thread.worktreePath!;
  const writer = await core.workspaceWriters.acquire(worktree, "saving a file", undefined, { shared: true });
  try {
    await expect(call("threads.delete", { id: thread.id })).rejects.toThrow(/saving a file/);
    expect(threads.get(core.db, thread.id)?.worktreePath).toBe(worktree);
    await access(worktree);
  } finally {
    writer.release();
  }
  await call("threads.delete", { id: thread.id });
  await expect(access(worktree)).rejects.toMatchObject({ code: "ENOENT" });
});

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
  expect(threads.get(core.db, started.thread.id)).toMatchObject({ workspaceMode: "worktree", worktreePath: worktree, branch: threads.get(core.db, home.id)!.branch });
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

it("starts a thread on another agent with the model last used there that can still run", async () => {
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(scripted);
  const claude = (id: string, unavailable?: string): ModelOption => ({ ...model(id, id), agent: "claude", ...(unavailable ? { unavailable } : {}) });
  const codexModels = await core.runs.models("codex");
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) =>
    agent === "claude" ? [claude("claude-trial"), claude("claude-steady"), claude("claude-retired", "Not on this plan")] : codexModels,
  );
  const earlier = threads.insert(core.db, { projectId: project.id, title: "Earlier", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  const ran = (id: string, model: string, startedAt: number) => {
    runs.insert(core.db, { id, taskId: null, threadId: earlier.id, agent: "claude", model, mode: "act", permissionMode: "trusted" });
    core.db.stmt("UPDATE runs SET started_at = ? WHERE id = ?").run(startedAt, id);
  };
  ran("earlier-steady", "claude-steady", 1_000);
  ran("earlier-retired", "claude-retired", 2_000);
  const { runId } = await parent();
  const started = await startThread(runId, { prompt: "Draft the copy", agent: "claude" });
  expect(started.model).toBe("claude-steady");
  expect(threads.get(core.db, started.thread.id)?.model).toBe("claude-steady");
});

it("starts a thread in Fast mode when asked, and refuses it on a model without Fast", async () => {
  const { runId } = await parent();
  const started = await startThread(runId, { prompt: "Build it", model: "6 astra", effort: "max", fast: true });
  expect(threads.get(core.db, started.thread.id)).toMatchObject({ model: "gpt-6-astra", effort: "max", fastMode: true });
  expect((await firstSpec(started.thread.id)).fastMode).toBe(true);
  await expect(startThread(runId, { prompt: "Build it", model: "6.1 sol", fast: true })).rejects.toThrow(/Fast mode is unavailable/);
});

it("starts as many threads working at once as it asks for, none of their own, and none from Plan mode", async () => {
  const { runId } = await parent();
  const children: Started[] = [];
  for (let index = 0; index < 6; index++) children.push(await startThread(runId, { prompt: `Part ${index + 1}` }));
  for (const child of children) expect(core.runs.threadActivity(child.thread.id)).not.toBe("idle");
  const first = await firstSpec(children[0]!.thread.id);
  await expect(startThread(first.runId, { prompt: "A grandchild" })).rejects.toThrow(/can't start its own/);
  const planning = await parent({ mode: "plan", prompt: "Think it through" });
  await expect(startThread(planning.runId, { prompt: "Do it" })).rejects.toThrow(/Plan mode/);
});

it("rejects Git and workspace mutations of a subagent before any side effects", async () => {
  const { runId, thread: home } = await parent();
  turns.get(runId)!.handle.emit("event", { type: "subagent.started", runId, ts: Date.now(), subagentId: "child", title: "Explore" });
  const child = threads.children(core.db, home.id)[0]!;
  await expect(call("review.commitThread", { threadId: child.id, message: "Forbidden" })).rejects.toThrow(/read-only/);
  await expect(call("review.pushThread", { threadId: child.id })).rejects.toThrow(/read-only/);
  await expect(call("review.createThreadPr", { threadId: child.id, title: "Forbidden", body: "", base: "main" })).rejects.toThrow(/read-only/);
  await expect(call("threads.moveWorkspace", { id: child.id, to: "current" })).rejects.toThrow(/read-only/);
});

it("lists messageable conversations before applying the agent's 30-thread limit", async () => {
  const { thread: home, runId } = await parent();
  const started = threads.insert(core.db, { projectId: project.id, title: "Started conversation", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  threads.update(core.db, started.id, { parentThreadId: home.id, parentRelation: "started" });
  for (let i = 0; i < 35; i++) {
    const child = threads.insert(core.db, { projectId: project.id, title: `Child ${i}`, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    threads.update(core.db, child.id, { parentThreadId: home.id, parentRelation: "subagent" });
  }
  expect((await core.threads.toolThreadList(runId)).map((thread) => thread.id).sort()).toEqual([home.id, started.id].sort());
  expect((await call("threads.list", { projectId: project.id, excludeSubagents: true, limit: 1 })).length).toBe(1);
  expect((await call("threads.list", { projectId: project.id, excludeSubagents: true })).map((thread) => thread.id).sort()).toEqual([home.id, started.id].sort());
});

/** A saved conversation in the project, on the CLI login unless it names another Claude account. */
const conversation = (title: string, claudeAccountId?: string) =>
  threads.insert(core.db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "trusted", ...(claudeAccountId ? { claudeAccountId } : {}) });

const task = (title: string, threadId: string | null) =>
  tasks.insert(core.db, { projectId: project.id, title, spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null, threadId });

/** Lets a test start Claude threads as well, on the scripted provider. */
async function scriptClaude() {
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(scripted);
  const codexModels = await core.runs.models("codex");
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => (agent === "claude" ? [{ ...model("claude-fixture", "Claude fixture"), agent: "claude" }] : codexModels));
  return { agent: "claude", model: "claude-fixture" } as const;
}

it("keeps the thread and task tools to the agent's own Claude account while accounts are kept separate", async () => {
  const { thread: home, runId } = await parent();
  const client = claudeAccounts.add(core.db, "Client").id;
  const same = conversation("On the same account");
  const elsewhere = conversation("On the client account", client);
  const ours = task("Our task", same.id);
  const theirs = task("Their task", elsewhere.id);
  const anyones = task("Anyone's task", null);
  const listed = async () => (await core.threads.toolThreadList(runId)).map((thread) => thread.id).sort();
  const taskIds = async () => (await core.threads.toolList(runId)).map((card) => card.id);
  expect(await listed()).toEqual([home.id, same.id, elsewhere.id].sort());
  expect(await taskIds()).toContain(theirs.id);

  const retired = vi.spyOn(core.runs, "retireIdleClaudeSessions");
  await call("app.settings.set", { claudeAccountsSeparate: true });
  expect(retired.mock.calls.map(([id]) => id).sort()).toEqual([DEFAULT_CLAUDE_ACCOUNT, client].sort());
  retired.mockClear();
  await call("app.settings.set", { claudeAccountsSeparate: true });
  expect(retired).not.toHaveBeenCalled();
  const later = Date.now() + 60_000;
  for (let index = 0; index < 31; index++) core.db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(later + index, conversation(`Client ${index}`, client).id);
  expect(await listed()).toEqual([home.id, same.id].sort());
  expect((await core.threads.toolThreadRead(runId, same.id))?.thread.id).toBe(same.id);
  expect(await core.threads.toolThreadRead(runId, elsewhere.id)).toBeNull();
  expect(await core.threads.toolThreadSend(runId, elsewhere.id, "Can you help?")).toEqual({ delivered: false, message: "No such thread in this project." });
  expect(await taskIds()).toEqual(expect.arrayContaining([anyones.id, ours.id]));
  expect(await taskIds()).not.toContain(theirs.id);
  expect(await core.threads.toolGet(runId, theirs.id)).toBeNull();

  retired.mockClear();
  await call("app.settings.set", { claudeAccountsSeparate: false });
  expect(retired.mock.calls.map(([id]) => id).sort()).toEqual([DEFAULT_CLAUDE_ACCOUNT, client].sort());
  expect(await taskIds()).toContain(theirs.id);
});

it.each(["codex", "claude"] as const)("keeps a %s agent on an added Claude account to that account's threads and tasks, and away from the CLI login's", async (agent) => {
  const claude = await scriptClaude();
  const client = claudeAccounts.add(core.db, "Client").id;
  const { thread: home, runId } = await parent({ ...(agent === "claude" ? claude : {}), claudeAccountId: client });
  expect(threads.get(core.db, home.id)).toMatchObject({ agent, claudeAccountId: client });
  const own = conversation("On the client account", client);
  const cli = conversation("On the CLI login");
  const mine = task("Its own task", own.id);
  const theirs = task("The CLI login's task", cli.id);
  const anyones = task("Anyone's task", null);
  await call("app.settings.set", { claudeAccountsSeparate: true });

  expect((await core.threads.toolThreadList(runId)).map((thread) => thread.id).sort()).toEqual([home.id, own.id].sort());
  expect((await core.threads.toolThreadRead(runId, own.id))?.thread.id).toBe(own.id);
  expect(await core.threads.toolThreadRead(runId, cli.id)).toBeNull();
  expect(await core.threads.toolThreadSend(runId, cli.id, "Can you help?")).toEqual({ delivered: false, message: "No such thread in this project." });
  expect((await core.threads.toolList(runId)).map((card) => card.id).sort()).toEqual([anyones.id, mine.id].sort());
  expect((await core.threads.toolGet(runId, mine.id))?.id).toBe(mine.id);
  expect(await core.threads.toolGet(runId, theirs.id)).toBeNull();
});

it("keeps a Claude run's file tools out of the other accounts' folders while accounts are kept separate", async () => {
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(scripted);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ ...model("claude-fixture", "Claude fixture"), agent: "claude" }]);
  const client = claudeAccounts.add(core.db, "Client").id;
  const { thread: before } = await parent({ agent: "claude", model: "claude-fixture" });
  expect((await firstSpec(before.id)).offLimits).toBeUndefined();
  await call("app.settings.set", { claudeAccountsSeparate: true });
  const { thread } = await parent({ agent: "claude", model: "claude-fixture" });
  const database = ["openorc.sqlite", "openorc.sqlite-wal", "openorc.sqlite-shm"].map((name) => path.join(folder, "data", name));
  expect((await firstSpec(thread.id)).offLimits).toEqual([path.join(folder, "data", "claude-accounts", client), ...database, path.join(folder, "data", "logs", "provider")]);
});

it("names in a Claude thread's memory brief only the tasks in progress on its own Claude account while accounts are kept separate", async () => {
  const claude = await scriptClaude();
  const client = claudeAccounts.add(core.db, "Client").id;
  settings.set(core.db, "memory.enabled", "true");
  memories.upsert(core.db, { projectId: project.id, type: "lesson", title: "Run the linter first", body: "CI stops at lint before the tests run.", source: "user" });
  const inProgress = (title: string, thread: { id: string }) => tasks.update(core.db, task(title, null).id, { status: "in_progress", executionThreadId: thread.id });
  inProgress("Send the client the invoice", conversation("On the client account", client));
  inProgress("Rotate the deploy keys", conversation("On the CLI login"));
  await call("app.settings.set", { claudeAccountsSeparate: true });
  const { thread } = await parent({ ...claude, claudeAccountId: client });
  const brief = (await firstSpec(thread.id)).systemPromptAppendix ?? "";
  expect(brief).toContain("- Task in progress: Send the client the invoice");
  expect(brief).not.toContain("Rotate the deploy keys");
});

/** A thread a person starts under `parentThreadId` from OpenOrc. */
const subthread = (parentThreadId: string, input: Partial<RpcParams<"threads.start">> = {}) =>
  call("threads.start", { projectId: project.id, parentThreadId, agent: "codex", model: "fixture-codex", mode: "act", permissionMode: "trusted", prompt: "Look into the flaky test", ...input });

it("starts as many subthreads as a person asks for, in the parent's worktree", async () => {
  const { thread: home, runId } = await parent({ workspaceMode: "worktree" });
  const worktree = threads.get(core.db, home.id)!.worktreePath!;
  const mine = [];
  for (let index = 0; index < 4; index++) mine.push((await subthread(home.id, { prompt: `Part ${index + 1}` })).thread);
  for (const each of mine) {
    expect(threads.get(core.db, each.id)).toMatchObject({
      parentThreadId: home.id,
      parentRelation: "started",
      startedByAgent: false,
      workspaceMode: "worktree",
      worktreePath: worktree,
      branch: threads.get(core.db, home.id)!.branch,
    });
    expect(core.runs.threadActivity(each.id)).not.toBe("idle");
  }
  const spec = await firstSpec(mine[0]!.id);
  expect(spec.cwd).toBe((await firstSpec(home.id)).cwd);
  expect(spec.prompt).not.toContain("started this thread");
  const helper = await startThread(runId, { prompt: "Agent helper" });
  expect(threads.get(core.db, helper.thread.id)).toMatchObject({ parentThreadId: home.id, startedByAgent: true });
});

it("lets a person's subthreads nest and their agents start threads, which a thread an agent started can't", async () => {
  const { thread: home } = await parent();
  const mine = (await subthread(home.id)).thread;
  const deeper = (await subthread(mine.id, { prompt: "Go deeper" })).thread;
  expect(threads.get(core.db, deeper.id)?.parentThreadId).toBe(mine.id);
  const helper = await startThread((await firstSpec(mine.id)).runId, { prompt: "Helper" });
  expect(threads.get(core.db, helper.thread.id)).toMatchObject({ parentThreadId: mine.id, startedByAgent: true });
  await expect(startThread((await firstSpec(helper.thread.id)).runId, { prompt: "Grandchild" })).rejects.toThrow(/can't start its own/);
});

it("refuses a subthread under a subagent, under a missing thread, or in a place of its own", async () => {
  const { thread: home, runId } = await parent();
  turns.get(runId)!.handle.emit("event", { type: "subagent.started", runId, ts: Date.now(), subagentId: "child", title: "Explore" });
  const child = threads.children(core.db, home.id)[0]!;
  await expect(subthread(child.id)).rejects.toThrow(/read-only/);
  await expect(subthread("missing")).rejects.toThrow(/not found/);
  await expect(subthread(home.id, { workspaceMode: "worktree" })).rejects.toThrow(/works in its folder/);
  expect(threads.children(core.db, home.id).map((each) => each.id)).toEqual([child.id]);
});

it.each(["codex", "claude"] as const)("keeps a person's %s subthread on its parent's Claude account while accounts are kept separate", async (agent) => {
  const on = agent === "claude" ? await scriptClaude() : {};
  const [work, client] = ["Work", "Client"].map((name) => claudeAccounts.add(core.db, name).id) as [string, string];
  const { thread: home } = await parent({ ...on, claudeAccountId: client });
  claudeAccounts.update(core.db, { id: work, makeDefault: true });
  // With the setting off it starts where the window says, or on the default.
  expect((await subthread(home.id, on)).thread.claudeAccountId).toBe(work);
  await call("app.settings.set", { claudeAccountsSeparate: true });

  await expect(subthread(home.id, { ...on, claudeAccountId: work })).rejects.toThrow("Settings keeps Claude accounts separate, so a subthread stays on its thread's account.");
  expect((await subthread(home.id, on)).thread.claudeAccountId).toBe(client);
  expect((await subthread(home.id, { ...on, claudeAccountId: client })).thread.claudeAccountId).toBe(client);

  projects.updateSettings(core.db, project.id, { claudeAccounts: { only: true, accountIds: [work], defaultId: work, autoSwitch: false } });
  const dropped = "This project doesn't use Client, and Settings keeps Claude accounts separate, so this can't start on another account.";
  await expect(subthread(home.id, on)).rejects.toThrow(dropped);
  await expect(subthread(home.id, { ...on, claudeAccountId: client })).rejects.toThrow(dropped);
  expect(threads.children(core.db, home.id)).toHaveLength(3);
});
