import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

it("rejects Workspace and unknown IDs without changing the visible list", async () => {
  const project = await service.import(root);
  expect(() => service.remove(WORKSPACE_ID)).toThrow("Workspace cannot be removed");
  expect(() => service.remove("missing")).toThrow("not found");
  expect(service.list()).toEqual([project]);
});
