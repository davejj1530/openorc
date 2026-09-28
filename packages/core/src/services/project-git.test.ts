import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects, tasks } from "@openorc/db";
import { emptyTree, git } from "@openorc/git";
import type { CorePush, RpcMethod, RpcParams, RpcResults, RunSpec } from "@openorc/protocol";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { OpenOrc } from "../openorc.js";
import { projectGit } from "./project-git.js";
import { threadTurnChanges } from "./thread-turn-changes.js";
import { directory } from "./workspace-home.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "project-git-"));
  dirs.push(dir);
  return directory(dir);
}

async function repository(dir: string, options: { commit?: boolean } = {}): Promise<void> {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  if (!options.commit) return;
  await writeFile(join(dir, "README.md"), "outer\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
}

/** A core whose Codex turns end once `duringTurn` has run, standing in for the agent's work. Warnings and errors it logs are kept. */
async function harness(root: string, duringTurn: () => Promise<void> = async () => {}) {
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec: RunSpec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, { send: async () => {}, interrupt() {}, close: () => finish(0), done });
    setTimeout(() => {
      handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: "codex", externalSessionId: spec.runId, model: "fixture" });
      void duringTurn().then(() => handle.emit("event", { type: "turn.completed", runId: spec.runId, ts: Date.now(), turnId: "turn", status: "success", durationMs: 1 }));
    }, 0);
    return handle;
  });
  const logs: string[] = [];
  const pushed: CorePush[] = [];
  const core = await OpenOrc.create({
    dataDir: join(root, "data"),
    ephemeral: true,
    transport: {
      push(message) {
        pushed.push(message);
        if (message.type === "log" && message.level !== "info") logs.push(message.message);
      },
    },
  });
  let requestId = 0;
  const call = async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    const id = ++requestId;
    await core.handle({ type: "rpc", id, method, params });
    const reply = pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);
    if (reply?.type !== "rpc.result") throw new Error(reply?.type === "rpc.error" ? reply.message : "Missing RPC reply");
    return reply.result as RpcResults[M];
  };
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  const input = { agent: "codex" as const, model: "fixture", effort: undefined, mode: "act" as const, permissionMode: "review" as const, attachments: undefined, title: undefined };
  /** One finished turn in the project folder, with its session closed so the thread can move. */
  const turn = async (projectId: string) => {
    const { thread, run } = await core.threads.start({ ...input, projectId, prompt: "Work on it" });
    await vi.waitFor(() => expect(core.threads.get(thread.id)?.activity).toBe("idle"));
    await core.runs.closeAndWait(run.id);
    return core.threads.get(thread.id)!;
  };
  return { core, logs, input, turn, call };
}

it("runs a folder without git as a project, keeps git features off with a reason, and never reaches a repository around it", async () => {
  const root = await temp();
  const outer = join(root, "outer");
  await mkdir(join(outer, "app"), { recursive: true });
  await repository(outer, { commit: true });
  const { core, logs, input, turn, call } = await harness(root);
  try {
    // As if the folder was added before a repository grew around it.
    const project = projects.insert(core.db, { name: "app", rootPath: join(outer, "app"), gitRemote: null, defaultBranch: null, settings: {} });
    expect(await projectGit(project)).toBe("none");
    const thread = await turn(project.id);
    expect(thread).toMatchObject({ workspaceMode: "current", baseSha: await emptyTree(join(outer, "app")), branch: null });
    expect(core.threads.checkpoints(thread.id)).toEqual([]);
    expect(logs).toEqual([]);
    expect((await git(outer, ["for-each-ref", "refs/openorc/"])).stdout).toBe("");
    await expect(core.review.threadDiff(thread, project)).rejects.toThrow("app isn't a git repository yet, so OpenOrc can't track or review its changes.");
    const needsGit = "app isn't a git repository yet. Worktrees and teams need git and a first commit.";
    expect(await core.threads.movePreview(thread.id, "worktree")).toEqual({ files: [], blocked: `This conversation cannot move. ${needsGit}` });
    await expect(core.threads.moveWorkspace(thread.id, "worktree")).rejects.toThrow(needsGit);
    await expect(core.threads.start({ ...input, projectId: project.id, prompt: "Isolate it", workspaceMode: "worktree" })).rejects.toThrow(needsGit);
    await core.threads.delete(thread.id);
    // Deleting the folder's task leaves the outer repository's stale worktree record for its own git to prune.
    await git(outer, ["worktree", "add", "-q", "-b", "stale", join(root, "stale")]);
    await rm(join(root, "stale"), { recursive: true, force: true });
    const task = tasks.insert(core.db, { projectId: project.id, title: "Tidy the notes", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
    await call("tasks.delete", { id: task.id });
    expect((await git(outer, ["worktree", "list", "--porcelain"])).stdout).toContain(join(root, "stale"));
    expect(logs).toEqual([]);
  } finally {
    await core.close();
  }
});

it("tracks a repository's changes before its first commit, and branches once it has one", async () => {
  const root = await temp();
  const folder = join(root, "designate");
  await mkdir(folder);
  await repository(folder);
  await writeFile(join(folder, "plan.md"), "# Plan\n");
  const { core, logs, input, turn } = await harness(root);
  try {
    const project = await core.projects.import(folder);
    expect(await projectGit(project)).toBe("no_commits");
    const thread = await turn(project.id);
    const empty = await emptyTree(folder);
    expect(thread).toMatchObject({ baseSha: empty, branch: "main" });
    const [first] = core.threads.checkpoints(thread.id);
    const firstTurn = { threadId: thread.id, checkpointId: first!.id };
    const planAdded = { files: [{ path: "plan.md", added: 1, removed: 0 }], patch: null };
    expect(await threadTurnChanges(core.db, firstTurn)).toEqual(planAdded);
    expect((await core.review.threadDiff(thread, project)).files).toEqual([{ path: "plan.md", status: "untracked", oldPath: null }]);
    expect(await core.review.threadLog(thread, project)).toEqual([]);
    expect(await core.review.threadPushState(thread, project)).toMatchObject({ blocked: "Make a first commit before pushing." });
    await expect(core.threads.moveWorkspace(thread.id, "worktree")).rejects.toThrow("designate has no commits yet. Worktrees and teams need a first commit.");

    const { sha } = await core.review.commitThread(thread, project, "Add the plan");
    expect(await projectGit(project)).toBe("ready");
    expect(await core.review.threadLog(thread, project)).toMatchObject([{ sha, subject: "Add the plan" }]);
    // The next turn prepares the thread again. Its starting point, and so its first turn, stay where they were.
    const next = await core.threads.continueThread(thread.id, { ...input, prompt: "Keep going" });
    await vi.waitFor(() => expect(core.threads.get(thread.id)?.activity).toBe("idle"));
    await core.runs.closeAndWait(next.id);
    expect(core.threads.get(thread.id)?.baseSha).toBe(empty);
    expect(await threadTurnChanges(core.db, firstTurn)).toEqual(planAdded);
    expect((await core.threads.moveWorkspace(thread.id, "worktree")).worktreePath).toBeTruthy();
    expect(logs).toEqual([]);
  } finally {
    await core.close();
  }
});

it("gives a thread a starting point when its agent sets up git during the first turn", async () => {
  const root = await temp();
  const folder = join(root, "sketch");
  await mkdir(folder);
  await writeFile(join(folder, "plan.md"), "# Plan\n");
  let firstTurnWork = true;
  const { core, logs, input, turn } = await harness(root, async () => {
    if (!firstTurnWork) return;
    firstTurnWork = false;
    // The agent sets up git, and even commits, before its first turn ends.
    await repository(folder);
    await git(folder, ["add", "-A"]);
    await git(folder, ["commit", "-q", "-m", "Start"]);
  });
  try {
    const project = await core.projects.import(folder);
    expect(await projectGit(project)).toBe("none");
    const thread = await turn(project.id);
    const empty = await emptyTree(folder);
    expect(thread.baseSha).toBe(empty);
    const [first] = core.threads.checkpoints(thread.id);
    const firstTurn = { threadId: thread.id, checkpointId: first!.id };
    const planAdded = { files: [{ path: "plan.md", added: 1, removed: 0 }], patch: null };
    expect(await threadTurnChanges(core.db, firstTurn)).toEqual(planAdded);
    // The next turn prepares the thread in a repository with a commit now. The starting point stays.
    const next = await core.threads.continueThread(thread.id, { ...input, prompt: "Keep going" });
    await vi.waitFor(() => expect(core.threads.get(thread.id)?.activity).toBe("idle"));
    await core.runs.closeAndWait(next.id);
    expect(core.threads.get(thread.id)?.baseSha).toBe(empty);
    expect(await threadTurnChanges(core.db, firstTurn)).toEqual(planAdded);
    expect(logs).toEqual([]);
  } finally {
    await core.close();
  }
});
