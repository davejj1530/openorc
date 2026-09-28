import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { orchestration, projects, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type CorePush, type Project, type RpcMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let folder: string;
let root: string;
let core: OpenOrc;
let project: Project;
let pushed: CorePush[];
let rpcId = 0;

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-thread-branches-"));
  root = path.join(folder, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "master"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "Branch fixture\n");
  await commitAll(root, "Initial commit");
  pushed = [];
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  project = projects.insert(core.db, { name: "Branches", rootPath: root, defaultBranch: "master", gitRemote: null, settings: {} });
});

afterEach(async () => {
  await core?.close();
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

function localThread() {
  return threads.insert(core.db, { projectId: project.id, title: "Local conversation", agent: "codex", model: null, mode: "plan", permissionMode: "trusted", workspaceMode: "current" });
}

async function taskThread() {
  const task = await call("tasks.create", { projectId: project.id, title: "Comments on task", workspaceMode: "current" });
  return call("tasks.openThread", { taskId: task.id });
}

function teamThread() {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Hi @everyone", agent: "codex", model: null, mode: "plan", permissionMode: "trusted", workspaceMode: "current" });
  const saved = orchestration.save(core.db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Branch team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture", effort: null, fastMode: false } }],
    },
  });
  orchestration.createInstance(core.db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  return thread;
}

const localConversations = [
  { kind: "team", create: teamThread },
  { kind: "ordinary", create: localThread },
  { kind: "task", create: taskThread },
];

it.each(localConversations)("shows the live checkout branch for existing $kind chats without launching a turn", async ({ create }) => {
  const thread = await create();
  expect(thread.branch).toBeNull();
  expect((await call("threads.list", { projectId: project.id }))[0]?.branch).toBe("master");
  expect((await call("threads.get", { id: thread.id }))?.branch).toBe("master");
  await git(root, ["checkout", "-q", "-b", "feature/current"]);
  expect((await call("threads.list", { projectId: project.id }))[0]?.branch).toBe("feature/current");
  expect((await call("threads.get", { id: thread.id }))?.branch).toBe("feature/current");
});

it.each(localConversations)("does not invent branches for $kind chats in detached, non-Git or missing checkouts", async ({ create }) => {
  const thread = await create();
  threads.update(core.db, thread.id, { branch: "stale-branch" });
  await git(root, ["checkout", "-q", "--detach"]);
  expect((await call("threads.get", { id: thread.id }))?.branch).toBeNull();
  await rm(path.join(root, ".git"), { recursive: true, force: true });
  expect((await call("threads.get", { id: thread.id }))?.branch).toBeNull();
  await rm(root, { recursive: true, force: true });
  expect((await call("threads.list", { projectId: project.id }))[0]?.branch).toBeNull();
});

it.each(localConversations)("preserves isolated $kind branch metadata and absent threads", async ({ create }) => {
  const thread = await create();
  threads.update(core.db, thread.id, { workspaceMode: "worktree", worktreePath: path.join(folder, "isolated"), branch: "openorc/team-isolated" });
  expect((await call("threads.list", { projectId: project.id }))[0]?.branch).toBe("openorc/team-isolated");
  threads.update(core.db, thread.id, { branch: null });
  expect((await call("threads.get", { id: thread.id }))?.branch).toBeNull();
  expect(await call("threads.get", { id: "missing" })).toBeNull();
});

it("initializes branch metadata when starting an ordinary local task conversation", async () => {
  const start = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, {
      done,
      send: async () => {},
      interrupt() {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
    });
    return handle;
  });
  const task = await call("tasks.create", { projectId: project.id, title: "Start in checkout", workspaceMode: "current" });
  const opened = await call("tasks.openThread", { taskId: task.id });
  expect(opened.branch).toBeNull();
  const run = await call("tasks.start", { taskId: task.id });
  expect(start).toHaveBeenCalledOnce();
  expect(await git(start.mock.calls[0]![0].cwd, ["symbolic-ref", "--short", "HEAD"])).toMatchObject({ stdout: "master\n" });
  expect(run.threadId).toBe(opened.id);
  expect(threads.get(core.db, opened.id)).toMatchObject({ branch: "master", baseSha: expect.any(String), workspaceMode: "current", worktreePath: null });
  expect((await call("threads.list", { projectId: project.id }))[0]?.branch).toBe("master");
  expect((await call("threads.get", { id: opened.id }))?.branch).toBe("master");
});
