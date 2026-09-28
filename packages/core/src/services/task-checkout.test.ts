import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, orchestration, projects, runs, tasks, threads } from "@openorc/db";
import { commitAll, git, teamTransfer } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type Project, type Task } from "@openorc/protocol";
import { TaskCheckoutService } from "./task-checkout.js";
import { WorkspaceWriters } from "./workspace-writers.js";

let db: Db, directory: string, root: string, source: string, project: Project, task: Task, writers: WorkspaceWriters, service: TaskCheckoutService;
const write = (cwd: string, name: string, content: string | Buffer) => writeFile(path.join(cwd, name), content);
const read = (cwd: string, name: string) => readFile(path.join(cwd, name), "utf8");
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "task-checkout-")));
  root = path.join(directory, "checkout");
  source = path.join(directory, "task");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "current-branch"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await write(root, "tracked.txt", "one\ntwo\nthree\n");
  await write(root, "delete.txt", "remove me\n");
  await write(root, "local.txt", "baseline\n");
  const base = await commitAll(root, "baseline");
  await git(root, ["worktree", "add", "-b", "task", source, base]);
  db = Db.memory();
  writers = new WorkspaceWriters();
  project = projects.insert(db, { name: "Fixture", rootPath: root, defaultBranch: "current-branch", gitRemote: null, settings: {} });
  task = tasks.insert(db, { projectId: project.id, title: "Finished task", spec: null, workspaceMode: "worktree", baseRef: "current-branch", priority: "none", labels: [], parentTaskId: null });
  task = tasks.update(db, task.id, { worktreePath: source, baseSha: base, branch: "task", status: "review" });
  service = new TaskCheckoutService(db, writers, directory);
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("finished task checkout application", () => {
  it("applies committed, dirty, new, binary and deleted files while preserving branch, staging, local edits and source", async () => {
    await write(source, "committed.txt", "committed output\n");
    await commitAll(source, "task commit");
    await write(source, "tracked.txt", "ONE\ntwo\nthree\n");
    await write(source, "new.txt", "new output\n");
    await write(source, "binary.bin", Buffer.from([0, 255, 1, 2]));
    await rm(path.join(source, "delete.txt"));
    await write(root, "local.txt", "staged\n");
    await git(root, ["add", "local.txt"]);
    await write(root, "local.txt", "staged and dirty\n");
    await write(root, "untracked.txt", "local only\n");
    await write(root, "tracked.txt", "one\ntwo\nTHREE\n");
    const index = await readFile(path.join(root, ".git/index"));
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout;
    const sourceBefore = await teamTransfer.capture(source, { refPrefix: "refs/openorc/test/source" });
    const preview = await service.prepare(task.id);
    expect(preview.state).toBe("ready");
    expect(preview.files).toBe(5);
    expect(preview.patch).toContain("committed output");
    expect(preview.patch).toContain("new output");
    expect(await read(root, "tracked.txt")).toBe("one\ntwo\nTHREE\n");
    expect((await service.apply(task.id, preview.id)).state).toBe("applied");
    expect(await read(root, "tracked.txt")).toBe("ONE\ntwo\nTHREE\n");
    expect(await read(root, "new.txt")).toBe("new output\n");
    expect(await read(root, "committed.txt")).toBe("committed output\n");
    expect(await readFile(path.join(root, "binary.bin"))).toEqual(Buffer.from([0, 255, 1, 2]));
    await expect(read(root, "delete.txt")).rejects.toThrow();
    expect(await read(root, "local.txt")).toBe("staged and dirty\n");
    expect(await read(root, "untracked.txt")).toBe("local only\n");
    expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    expect((await git(root, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await git(root, ["branch", "--show-current"])).stdout.trim()).toBe("current-branch");
    expect((await teamTransfer.capture(source, { refPrefix: "refs/openorc/test/after" })).treeSha).toBe(sourceBefore.treeSha);
    expect(tasks.get(db, task.id)?.status).toBe("review");
    expect((await service.apply(task.id, preview.id)).state).toBe("applied");
    const repeated = await service.prepare(task.id);
    expect(repeated.files).toBe(0);
    await service.apply(task.id, repeated.id);
    await write(source, "new.txt", "new output\nnext edit\n");
    const incremental = await service.prepare(task.id);
    expect(incremental.files).toBe(1);
    await service.apply(task.id, incremental.id);
    expect(await read(root, "new.txt")).toContain("next edit");
  }, 30000);

  it("retains conflicts without applying even the nonconflicting files; permits a fresh preview after resolution", async () => {
    await write(source, "tracked.txt", "task conflict\n");
    await write(source, "safe.txt", "safe\n");
    await write(root, "tracked.txt", "local conflict\n");
    const preview = await service.prepare(task.id);
    expect(preview.state).toBe("conflict");
    expect(preview.conflicts).toContain("tracked.txt");
    expect(await read(root, "tracked.txt")).toBe("local conflict\n");
    await expect(read(root, "safe.txt")).rejects.toThrow();
    await expect(service.apply(task.id, preview.id)).rejects.toThrow(/Resolve/);
    expect(await read(preview.scratchPath, "tracked.txt")).toContain("<<<<<<<");
    await write(source, "tracked.txt", "local conflict\n");
    const resolved = await service.prepare(task.id);
    expect(resolved.state).toBe("ready");
    await service.apply(task.id, resolved.id);
    expect(await read(root, "safe.txt")).toBe("safe\n");
  }, 15000);

  it("blocks untracked collisions, stale source previews and stale destination edits without writes", async () => {
    await write(source, "collision.txt", "task\n");
    await write(root, "collision.txt", "local\n");
    expect((await service.prepare(task.id)).state).toBe("conflict");
    expect(await read(root, "collision.txt")).toBe("local\n");
    await write(source, "collision.txt", "local\n");
    await write(source, "tracked.txt", "updated\n");
    const preview = await service.prepare(task.id);
    await write(source, "newer.txt", "after preview\n");
    await expect(service.apply(task.id, preview.id)).rejects.toThrow(/source changed/);
    const fresh = await service.prepare(task.id);
    await write(root, "tracked.txt", "external\n");
    await expect(service.apply(task.id, fresh.id)).rejects.toThrow(/External changes/);
    expect(await read(root, "tracked.txt")).toBe("external\n");
    await expect(read(root, "newer.txt")).rejects.toThrow();
    expect((await service.prepare(task.id)).state).toBe("conflict");
  }, 20000);

  it("retries the immutable journal after interruption, including after reconstructing the service", async () => {
    await write(source, "a.txt", "A\n");
    await write(source, "b.txt", "B\n");
    let fail = true;
    service = new TaskCheckoutService(db, writers, directory, (point) => {
      if (point === "after-write" && fail) {
        fail = false;
        throw new Error("simulated interruption");
      }
    });
    const preview = await service.prepare(task.id);
    const interrupted = await service.apply(task.id, preview.id);
    expect(interrupted.state).toBe("attention");
    expect(interrupted.error).toContain("simulated interruption");
    await expect(service.prepare(task.id)).rejects.toThrow(/Retry the retained/);
    service = new TaskCheckoutService(db, writers, directory);
    expect((await service.state(task.id)).preview?.state).toBe("attention");
    expect((await service.apply(task.id, preview.id)).state).toBe("applied");
    expect(await read(root, "a.txt")).toBe("A\n");
    expect(await read(root, "b.txt")).toBe("B\n");
    await expect(service.apply(task.id, "wrong-preview")).rejects.toThrow(/preview was replaced/);
  }, 15000);

  it("rejects staging changes, ignored destination collisions and native Git operations before any write", async () => {
    await write(source, "first.txt", "task output\n");
    const preview = await service.prepare(task.id);
    await write(root, "local.txt", "new staging\n");
    await git(root, ["add", "local.txt"]);
    await expect(service.apply(task.id, preview.id)).rejects.toThrow(/staging changed/);
    await expect(read(root, "first.txt")).rejects.toThrow();
    await write(root, ".gitignore", "hidden.txt\n");
    await write(root, "hidden.txt", "ignored local data\n");
    await write(source, "hidden.txt", "task data\n");
    const collision = await service.prepare(task.id);
    await expect(service.apply(task.id, collision.id)).rejects.toThrow(/External changes at hidden.txt/);
    await expect(read(root, "first.txt")).rejects.toThrow();
    expect(await read(root, "hidden.txt")).toBe("ignored local data\n");
    await writeFile(path.join(root, ".git/MERGE_HEAD"), task.baseSha! + "\n");
    await expect(service.prepare(task.id)).rejects.toThrow(/Finish the Git operation/);
    expect((await service.state(task.id)).preview?.id).toBe(collision.id);
  }, 15000);

  it("gates both writers and active runs, and refuses team-owned tasks", async () => {
    await write(source, "new.txt", "output\n");
    const preview = await service.prepare(task.id);
    for (const target of [source, root]) {
      const lease = await writers.acquire(target, "active fixture agent");
      try {
        expect((await service.state(task.id)).reason).toContain("active fixture agent");
        await expect(service.prepare(task.id)).rejects.toThrow(/in use/);
        await expect(service.apply(task.id, preview.id)).rejects.toThrow(/in use/);
      } finally {
        lease.release();
      }
    }
    const run = runs.insert(db, { id: "active-run", taskId: task.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    expect((await service.state(task.id)).reason).toContain("Finish or stop");
    db.stmt("UPDATE runs SET ended_at = ?, state = 'success' WHERE id = ?").run(Date.now(), run.id);
    const thread = threads.insert(db, { projectId: project.id, title: "Team", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const team = orchestration.save(db, {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Team",
        limits: { ...DEFAULT_TEAM_LIMITS },
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture", effort: "high", fastMode: false } }],
      },
    });
    orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
    db.stmt("UPDATE tasks SET thread_id = ? WHERE id = ?").run(thread.id, task.id);
    expect((await service.state(task.id)).reason).toContain("team conversation");
    await expect(service.apply(task.id, preview.id)).rejects.toThrow(/team conversation/);
  }, 15000);
});
