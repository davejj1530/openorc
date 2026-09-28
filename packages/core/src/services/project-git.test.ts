import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "@openorc/db";
import { git } from "@openorc/git";
import type { RunSpec } from "@openorc/protocol";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { OpenOrc } from "../openorc.js";
import { projectGit } from "./project-git.js";
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

/** A core whose Codex turns end as soon as they start. Warnings and errors it logs are kept. */
async function harness(root: string) {
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec: RunSpec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, { send: async () => {}, interrupt() {}, close: () => finish(0), done });
    setTimeout(() => {
      handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: "codex", externalSessionId: spec.runId, model: "fixture" });
      handle.emit("event", { type: "turn.completed", runId: spec.runId, ts: Date.now(), turnId: "turn", status: "success", durationMs: 1 });
    }, 0);
    return handle;
  });
  const logs: string[] = [];
  const core = await OpenOrc.create({
    dataDir: join(root, "data"),
    ephemeral: true,
    transport: {
      push(message) {
        if (message.type === "log" && message.level !== "info") logs.push(message.message);
      },
    },
  });
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
  return { core, logs, input, turn };
}

it("runs a folder without git as a project, keeps git features off with a reason, and never reaches a repository around it", async () => {
  const root = await temp();
  const outer = join(root, "outer");
  await mkdir(join(outer, "app"), { recursive: true });
  await repository(outer, { commit: true });
  const { core, logs, input, turn } = await harness(root);
  try {
    // As if the folder was added before a repository grew around it.
    const project = projects.insert(core.db, { name: "app", rootPath: join(outer, "app"), gitRemote: null, defaultBranch: null, settings: {} });
    expect(await projectGit(project)).toBe("none");
    const thread = await turn(project.id);
    expect(thread).toMatchObject({ workspaceMode: "current", baseSha: null, branch: null });
    expect(core.threads.checkpoints(thread.id)).toEqual([]);
    expect(logs).toEqual([]);
    expect((await git(outer, ["for-each-ref", "refs/openorc/"])).stdout).toBe("");
    await expect(core.review.threadDiff(thread, project)).rejects.toThrow("app isn't a git repository yet, so OpenOrc can't track or review its changes.");
    const needsGit = "app isn't a git repository yet. Worktrees and teams need git and a first commit.";
    expect(await core.threads.movePreview(thread.id, "worktree")).toEqual({ files: [], blocked: `This conversation cannot move. ${needsGit}` });
    await expect(core.threads.moveWorkspace(thread.id, "worktree")).rejects.toThrow(needsGit);
    await expect(core.threads.start({ ...input, projectId: project.id, prompt: "Isolate it", workspaceMode: "worktree" })).rejects.toThrow(needsGit);
    await core.threads.delete(thread.id);
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
  const { core, logs, turn } = await harness(root);
  try {
    const project = await core.projects.import(folder);
    expect(await projectGit(project)).toBe("no_commits");
    const thread = await turn(project.id);
    expect(thread).toMatchObject({ baseSha: null, branch: "main" });
    expect(core.threads.checkpoints(thread.id)).toHaveLength(1);
    expect((await core.review.threadDiff(thread, project)).files).toEqual([{ path: "plan.md", status: "untracked", oldPath: null }]);
    expect(await core.review.threadLog(thread, project)).toEqual([]);
    expect(await core.review.threadPushState(thread, project)).toMatchObject({ blocked: "Make a first commit before pushing." });
    await expect(core.threads.moveWorkspace(thread.id, "worktree")).rejects.toThrow("designate has no commits yet. Worktrees and teams need a first commit.");

    const { sha } = await core.review.commitThread(thread, project, "Add the plan");
    expect(await projectGit(project)).toBe("ready");
    expect(await core.review.threadLog(thread, project)).toMatchObject([{ sha, subject: "Add the plan" }]);
    expect((await core.threads.moveWorkspace(thread.id, "worktree")).worktreePath).toBeTruthy();
    expect(logs).toEqual([]);
  } finally {
    await core.close();
  }
});
