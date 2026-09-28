import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Db, projects, runs, schedules, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { WORKSPACE_ID } from "@openorc/protocol";
import { createProjectsHandlers } from "../handlers/projects.js";
import { ProjectService } from "./projects.js";

let dir: string;
let root: string;
let db: Db;
let service: ProjectService;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openorc-project-removal-"));
  root = path.join(dir, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "Keep this repository\n");
  await commitAll(root, "init");
  db = Db.open(path.join(dir, "ledger.sqlite"));
  service = new ProjectService(db);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

it("removes only list membership, persists it, and re-imports the same project with all its work intact", async () => {
  const project = await service.import(root);
  const thread = threads.insert(db, { projectId: project.id, title: "Keep history", agent: "codex", model: null, mode: "act", permissionMode: "review" });
  const task = tasks.insert(db, { projectId: project.id, title: "Keep task", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
  const run = runs.insert(db, { id: "active-run", threadId: thread.id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "review" });
  const schedule = schedules.insert(db, {
    projectId: project.id,
    title: "Review",
    prompt: "Review",
    agent: "codex",
    model: null,
    effort: null,
    mode: "plan",
    permissionMode: "review",
    workspaceMode: "current",
    everyMinutes: 60,
  });
  const worktree = path.join(dir, "worktree");
  await git(root, ["worktree", "add", "-q", "-b", "retained", worktree]);
  threads.update(db, thread.id, { worktreePath: worktree, workspaceMode: "worktree" });
  const invalidate = vi.fn();
  const handlers = createProjectsHandlers({ db, projectService: service, invalidate, transport: { push() {} } });

  expect(await handlers["projects.remove"]({ id: project.id })).toEqual({ ok: true });
  expect(invalidate).toHaveBeenCalledWith(["projects", `project:${project.id}`]);
  expect(await handlers["projects.list"]({})).toEqual([]);
  expect(await handlers["projects.get"]({ id: project.id })).toMatchObject({ id: project.id });
  // Retained projects remain available to safety checks that protect repository roots.
  expect(projects.list(db, { includeRemoved: true }).map((p) => p.id)).toEqual([project.id]);
  db.close();
  db = Db.open(path.join(dir, "ledger.sqlite"));
  service = new ProjectService(db);
  expect(service.list()).toEqual([]);
  expect(threads.get(db, thread.id)?.worktreePath).toBe(worktree);
  expect(tasks.get(db, task.id)).toEqual(task);
  expect(runs.get(db, run.id)).toEqual(run);
  expect(schedules.get(db, schedule.id)).toEqual(schedule);
  expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("Keep this repository\n");
  expect(await readFile(path.join(worktree, "README.md"), "utf8")).toBe("Keep this repository\n");
  const restored = await service.import(root);
  expect(restored).toMatchObject({ id: project.id, createdAt: project.createdAt, settings: project.settings });
  expect(service.list()).toEqual([restored]);
  expect(await service.import(root)).toEqual(restored);
  expect(threads.list(db, { projectId: restored.id })).toHaveLength(1);
});

it("makes retries idempotent and audits removal and restoration once each", async () => {
  const project = await service.import(root);
  service.remove(project.id);
  const removed = service.get(project.id);
  service.remove(project.id);
  expect(service.get(project.id)).toEqual(removed);
  await service.import(root);
  await service.import(root);
  const actions = db.stmt("SELECT action FROM audit_events WHERE resource_id = ? ORDER BY id").all(project.id);
  expect(actions.map((entry) => entry.action)).toEqual(["project.import", "project.remove", "project.restore"]);
});

it("imports a plain folder and a repository without commits as they are", async () => {
  const plain = path.join(dir, "plain");
  await mkdir(plain);
  expect(await service.import(plain)).toMatchObject({ name: "plain", rootPath: await realpath(plain), gitRemote: null, defaultBranch: null });
  const fresh = path.join(dir, "fresh");
  await mkdir(fresh);
  await git(fresh, ["init", "-q", "-b", "main"]);
  expect(await service.import(fresh)).toMatchObject({ name: "fresh", rootPath: await realpath(fresh), defaultBranch: null });
  // A folder inside a repository still brings the whole repository.
  await mkdir(path.join(root, "src"));
  expect(await service.import(path.join(root, "src"))).toMatchObject({ rootPath: await realpath(root) });
  await expect(service.import(path.join(dir, "missing"))).rejects.toThrow("This folder does not exist or is unavailable.");
  expect(
    service
      .list()
      .map((project) => project.name)
      .sort(),
  ).toEqual(["fresh", "plain", "repo"]);
});

it("fills in the remote and default branch once a folder added without git gains them", async () => {
  const folder = path.join(dir, "later");
  await mkdir(folder);
  const project = await service.import(folder);
  const invalidate = vi.fn();
  const handlers = createProjectsHandlers({ db, projectService: service, invalidate, transport: { push() {} } });
  expect(await handlers["projects.git"]({ id: project.id })).toBe("none");
  await git(folder, ["init", "-q", "-b", "trunk"]);
  await git(folder, ["config", "user.email", "test@example.com"]);
  await git(folder, ["config", "user.name", "Test"]);
  await writeFile(path.join(folder, "plan.md"), "# Plan\n");
  await commitAll(folder, "init");
  await git(folder, ["remote", "add", "origin", "https://github.com/example/later.git"]);
  expect(invalidate).not.toHaveBeenCalled();
  expect(await handlers["projects.git"]({ id: project.id })).toBe("ready");
  expect(invalidate).toHaveBeenCalledWith(["projects", `project:${project.id}`]);
  expect(service.get(project.id)).toMatchObject({ gitRemote: "https://github.com/example/later.git", defaultBranch: "trunk", updatedAt: project.updatedAt });
  // Known values stay put, even when git would now guess another branch.
  await git(folder, ["checkout", "-q", "-b", "other"]);
  expect(await service.git(project.id)).toEqual({ state: "ready", changed: false });
  expect(service.get(project.id)?.defaultBranch).toBe("trunk");
});

it("rejects Workspace and unknown IDs without changing the visible list", async () => {
  const project = await service.import(root);
  expect(() => service.remove(WORKSPACE_ID)).toThrow("Workspace cannot be removed");
  expect(() => service.remove("missing")).toThrow("not found");
  expect(service.list()).toEqual([project]);
});

it("reads the live checkout branch without replacing the saved default branch", async () => {
  const project = await service.import(root);
  projects.updateGit(db, project.id, { defaultBranch: "dev", gitRemote: null });
  const handlers = createProjectsHandlers({ db, projectService: service, invalidate: vi.fn(), transport: { push() {} } });
  const branch = () => handlers["projects.checkoutBranch"]({ id: project.id });
  await git(root, ["checkout", "-q", "-b", "prod"]);
  expect(await branch()).toBe("prod");
  await git(root, ["checkout", "-q", "-b", "hotfix"]);
  expect(await branch()).toBe("hotfix");
  await git(root, ["checkout", "-q", "--detach"]);
  expect(await branch()).toBeNull();
  expect(service.get(project.id)?.defaultBranch).toBe("dev");
  await rm(path.join(root, ".git"), { recursive: true, force: true });
  expect(await branch()).toBeNull();
  await rm(root, { recursive: true, force: true });
  expect(await branch()).toBeNull();
  expect(await handlers["projects.checkoutBranch"]({ id: WORKSPACE_ID })).toBeNull();
  await expect(handlers["projects.checkoutBranch"]({ id: "missing" })).rejects.toThrow("not found");
});

it("reads unborn branches and never borrows a parent repository's branch", async () => {
  const fresh = path.join(dir, "fresh");
  await mkdir(fresh);
  await git(fresh, ["init", "-q", "-b", "prod"]);
  const project = await service.import(fresh);
  expect(await service.checkoutBranch(project.id)).toBe("prod");
  const nested = path.join(root, "plain");
  await mkdir(nested);
  const plain = projects.insert(db, { name: "Plain folder", rootPath: nested, gitRemote: null, defaultBranch: null, settings: {} });
  expect(await service.checkoutBranch(plain.id)).toBeNull();
});
