import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, projects, tasks, threads } from "@openorc/db";
import { git, worktree } from "@openorc/git";
import type { Project, Task } from "@openorc/protocol";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

let directory: string;
let root: string;
let db: Db;
let project: Project;
let service: WorkspaceService;
let writers: WorkspaceWriters;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-workspace-")));
  root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Fixture"]);
  db = Db.memory();
  project = projects.insert(db, {
    name: "Fixture",
    rootPath: root,
    gitRemote: null,
    defaultBranch: "main",
    settings: { setupScript: 'printf "setup\\n" >> "$OPENORC_ROOT_PATH/setup-runs.txt"', worktreeInclude: [] },
  });
  writers = new WorkspaceWriters();
  service = new WorkspaceService(db, { dataDir: path.join(directory, "data") }, { info() {}, warn() {}, error() {} }, writers);
});

afterEach(async () => {
  await service?.shutdown();
  db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function task(workspaceMode: Task["workspaceMode"] = "worktree", baseRef = "HEAD"): Task {
  return tasks.insert(db, { projectId: project.id, title: "Prepare review workspace", spec: null, priority: "none", labels: [], workspaceMode, baseRef, parentTaskId: null });
}

describe("task workspace preparation", () => {
  it("rejects preparation and cleanup while another writer owns the physical path", async () => {
    const unprepared = task();
    const reservedPath = service.taskPath(unprepared, project);
    const lease = await writers.acquire(reservedPath, "active provider");
    try {
      await expect(service.prepare(unprepared, project)).rejects.toThrow(/active provider/);
      await expect(service.cleanup(unprepared, project)).rejects.toThrow(/active provider/);
      expect(tasks.get(db, unprepared.id)).toEqual(unprepared);
      expect(await worktree.list(root)).toHaveLength(1);
    } finally {
      lease.release();
    }
  });

  it("keeps setup ownership after process exit until its streams and descendants close", async () => {
    const unprepared = task();
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValueOnce(proc as unknown as ChildProcess);
    const preparation = service.prepare(unprepared, project);
    let settled = false;
    void preparation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(tasks.get(db, unprepared.id)?.worktreePath).toBeTruthy());
      proc.emit("exit", 0);
      await expect(writers.acquire(service.taskPath(unprepared, project), "provider run")).rejects.toThrow(/preparing task/);
      expect(settled).toBe(false);
      proc.emit("close", 0);
      const prepared = await preparation;
      await writers.withLease(prepared.worktreePath!, "provider run", async () => {});
    } finally {
      proc.emit("close", 0);
      await preparation.catch(() => {});
    }
  });

  it("retains a timed-out setup reservation until close is confirmed and rejects later admission", async () => {
    const unprepared = task();
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValueOnce(proc as unknown as ChildProcess);
    const preparation = service.prepare(unprepared, project);
    const outcome = preparation.then(
      () => null,
      (error) => error,
    );
    try {
      await vi.waitFor(() => expect(tasks.get(db, unprepared.id)?.worktreePath).toBeTruthy());
      await expect(service.shutdown(10)).rejects.toThrow(/Keep the database open/);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      await expect(writers.acquire(service.taskPath(unprepared, project), "replacement writer")).rejects.toThrow(/preparing task/);
      await expect(service.prepare(task(), project)).rejects.toThrow(/shutting down/);
      proc.emit("close", null);
      expect(await outcome).toEqual(expect.objectContaining({ message: "Workspace preparation is shutting down." }));
      await service.shutdown();
      await writers.withLease(service.taskPath(unprepared, project), "after shutdown", async () => {});
    } finally {
      proc.emit("close", null);
      await outcome;
    }
  });

  it("waits for task and thread preparation and prevents DB writes after an awaited Git stage", async () => {
    const unprepared = task();
    const thread = threads.insert(db, { projectId: project.id, title: "Pending setup", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const add = vi.spyOn(worktree, "add").mockImplementation(async () => {
      await gate;
    });
    const preparations = [service.prepare(unprepared, project), service.prepareThread(thread, project, "HEAD")];
    const results = Promise.allSettled(preparations);
    try {
      await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2));
      await expect(service.shutdown(10)).rejects.toThrow(/Keep the database open/);
      await expect(writers.acquire(service.taskPath(unprepared, project), "replacement task")).rejects.toThrow(/preparing task/);
      await expect(writers.acquire(service.threadPath(thread, project), "replacement thread")).rejects.toThrow(/preparing thread/);
      release();
      expect((await results).every((result) => result.status === "rejected" && /shutting down/.test(String(result.reason)))).toBe(true);
      await service.shutdown();
      expect(tasks.get(db, unprepared.id)).toEqual(unprepared);
      expect(threads.get(db, thread.id)).toEqual(thread);
    } finally {
      release();
      await results;
    }
  });

  it.skipIf(process.platform === "win32").each(["wrapper exit", "shutdown"] as const)(
    "stops redirected setup descendants on %s before releasing ownership",
    async (mode) => {
      const pidFile = path.join(directory, "setup-child.pid");
      const childFile = path.join(directory, "setup-child.cjs");
      const wrapperFile = path.join(directory, "setup-wrapper.cjs");
      await writeFile(childFile, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
      await writeFile(
        wrapperFile,
        `
const fs = require('node:fs');
require('node:child_process').spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: 'ignore' });
const ready = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(pidFile)})) return;
  clearInterval(ready);
  ${mode === "wrapper exit" ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
}, 10);
`,
      );
      const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;
      const configured = projects.updateSettings(db, project.id, { setupScript: `exec ${quote(process.execPath)} ${quote(wrapperFile)}` });
      const unprepared = task();
      const preparation = service.prepare(unprepared, configured);
      const outcome = preparation.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let pid: number | undefined;
      try {
        let awaitingStartup = true;
        const descendantReady = vi.waitFor(
          async () => {
            if (!awaitingStartup) return;
            pid = Number(await readFile(pidFile, "utf8"));
            expect(pid).toBeGreaterThan(0);
          },
          { timeout: 10000 },
        );
        try {
          await Promise.race([
            descendantReady,
            outcome.then((result) => {
              if ("error" in result) throw new Error("Setup failed before its descendant became ready.", { cause: result.error });
              return descendantReady;
            }),
          ]);
        } finally {
          awaitingStartup = false;
        }
        if (mode === "shutdown") await service.shutdown();
        const result = await outcome;
        if (mode === "shutdown") expect(result).toMatchObject({ error: expect.objectContaining({ message: "Workspace preparation is shutting down." }) });
        else expect(result).toMatchObject({ value: { id: unprepared.id } });
        expect(() => process.kill(pid!, 0)).toThrow();
        await writers.withLease(service.taskPath(unprepared, project), "after setup group", async () => {});
      } finally {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await service.shutdown();
        await outcome;
      }
    },
    25000,
  );

  it("shares concurrent review preparation and reuses the completed workspace for stale callers", async () => {
    const unprepared = task();
    const results = await Promise.allSettled([service.prepare(unprepared, project), service.prepare({ ...unprepared }, project), service.prepare({ ...unprepared }, project)]);
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const prepared = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(prepared).toHaveLength(3);
    expect(new Set(prepared.map((value) => value.worktreePath)).size).toBe(1);
    expect(prepared[0]?.worktreePath).toBeTruthy();
    expect(await readFile(path.join(root, "setup-runs.txt"), "utf8")).toBe("setup\n");
    expect(await worktree.list(root)).toHaveLength(2);

    // A second panel may still hold the pre-prepare task after the first request settles.
    expect(await service.prepare(unprepared, project)).toEqual(prepared[0]);
    expect(await readFile(path.join(root, "setup-runs.txt"), "utf8")).toBe("setup\n");
    expect(await worktree.list(root)).toHaveLength(2);
  });

  it("releases failed preparation and retries with the corrected persisted start ref", async () => {
    const unprepared = task("worktree", "missing-base-ref");
    const failed = await Promise.allSettled([service.prepare(unprepared, project), service.prepare({ ...unprepared }, project)]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(tasks.get(db, unprepared.id)?.worktreePath).toBeNull();
    expect(await worktree.list(root)).toHaveLength(1);

    tasks.update(db, unprepared.id, { baseRef: "HEAD" });
    const prepared = await service.prepare(unprepared, project);
    expect(prepared.worktreePath).toBeTruthy();
    expect(prepared.baseRef).toBe("HEAD");
    expect(await readFile(path.join(root, "setup-runs.txt"), "utf8")).toBe("setup\n");
    expect(await worktree.list(root)).toHaveLength(2);
  });

  it("copies include matches only from inside the checkout, never through links or parent paths", async () => {
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await writeFile(path.join(root, ".env"), "LOCAL=1\n");
    await symlink(outside, path.join(root, "linked"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link.txt"));
    const includes = { ...project, settings: { ...project.settings, worktreeInclude: [".env", "../outside/secret.txt", "linked/secret.txt", "secret-link.txt"] } };

    const prepared = await service.prepare(task(), includes);
    const worktreePath = prepared.worktreePath!;

    expect(await readFile(path.join(worktreePath, ".env"), "utf8")).toBe("LOCAL=1\n");
    for (const escaped of [path.join(worktreePath, "..", "outside", "secret.txt"), path.join(worktreePath, "linked", "secret.txt"), path.join(worktreePath, "secret-link.txt")]) {
      await expect(access(escaped)).rejects.toThrow();
    }
  });

  it("honors the persisted current-checkout choice without creating a worktree or running setup", async () => {
    const unprepared = task();
    tasks.update(db, unprepared.id, { workspaceMode: "current" });
    const [first, second] = await Promise.all([service.prepare(unprepared, project), service.prepare(unprepared, project)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ workspaceMode: "current", worktreePath: null, branch: "main" });
    expect(first.baseSha).toBe((await git(root, ["rev-parse", "HEAD"])).stdout.trim());
    expect(await worktree.list(root)).toHaveLength(1);
    await expect(readFile(path.join(root, "setup-runs.txt"))).rejects.toThrow(/ENOENT/);
  });
});

describe("removing a task worktree", () => {
  beforeEach(async () => {
    await git(root, ["config", "user.name", "Fixture"]);
    await git(root, ["config", "user.email", "fixture@example.com"]);
  });

  it("commits uncommitted work to the branch first, so removing the worktree frees disk without losing it", async () => {
    const prepared = await service.prepare(task(), project);
    await writeFile(path.join(prepared.worktreePath!, "README.md"), "# Fixture\nedited by the agent\n");
    await writeFile(path.join(prepared.worktreePath!, "draft.ts"), "export const draft = true;\n");
    const removed = await service.cleanup(prepared, project);
    expect(removed.worktreePath).toBeNull();
    expect((await worktree.list(root)).map((entry) => entry.path)).not.toContain(prepared.worktreePath);
    expect((await git(root, ["show", `${prepared.branch}:draft.ts`])).stdout).toContain("draft = true");
    expect((await git(root, ["show", `${prepared.branch}:README.md`])).stdout).toContain("edited by the agent");
  });

  it("keeps the worktree when its work cannot be saved", async () => {
    const prepared = await service.prepare(task(), project);
    await git(prepared.worktreePath!, ["checkout", "-q", "--detach"]);
    await writeFile(path.join(prepared.worktreePath!, "draft.ts"), "export const draft = true;\n");
    await expect(service.cleanup(prepared, project)).rejects.toThrow(/not on a branch/);
    expect(await readFile(path.join(prepared.worktreePath!, "draft.ts"), "utf8")).toContain("draft = true");
    expect(tasks.get(db, prepared.id)?.worktreePath).toBe(prepared.worktreePath);
  });

  it("does not save work onto a branch it is deleting", async () => {
    const prepared = await service.prepare(task(), project);
    await git(prepared.worktreePath!, ["checkout", "-q", "--detach"]);
    await writeFile(path.join(prepared.worktreePath!, "draft.ts"), "export const draft = true;\n");
    await expect(service.cleanup(prepared, project, { deleteBranch: true })).rejects.toThrow(/1 uncommitted file/);
    const removed = await service.cleanup(prepared, project, { deleteBranch: true, acceptLoss: { uncommitted: 1, commits: 0 } });
    expect(removed.worktreePath).toBeNull();
  });

  it("saves a thread's uncommitted work to its branch too, unless the changes were already moved elsewhere", async () => {
    const thread = () => threads.insert(db, { projectId: project.id, title: "Removal", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const kept = await service.prepareThread(thread(), project, "HEAD");
    await writeFile(path.join(kept.worktreePath!, "draft.ts"), "export const draft = true;\n");
    await service.cleanupThread(kept, project);
    expect((await git(root, ["show", `${kept.branch}:draft.ts`])).stdout).toContain("draft = true");

    const moved = await service.prepareThread(thread(), project, "HEAD");
    await writeFile(path.join(moved.worktreePath!, "draft.ts"), "export const draft = true;\n");
    await service.cleanupThread(moved, project, { save: false });
    expect((await git(root, ["ls-tree", "--name-only", moved.branch!])).stdout).not.toContain("draft.ts");
  });
});

describe("thread workspace preparation", () => {
  it("remembers the branch a thread's worktree started from, for its pull request's target", async () => {
    const thread = () => threads.insert(db, { projectId: project.id, title: "Start", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    await git(root, ["branch", "dev"]);
    expect((await service.prepareThread(thread(), project, "dev")).baseBranch).toBe("dev");
    // HEAD is whatever the checkout is on, as when a conversation moves out of it.
    expect((await service.prepareThread(thread(), project, "HEAD")).baseBranch).toBe("main");
    const sha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    expect((await service.prepareThread(thread(), project, sha)).baseBranch).toBeNull();
    await git(root, ["checkout", "-q", "--detach"]);
    expect((await service.prepareThread(thread(), project, "HEAD")).baseBranch).toBeNull();
  });
});
