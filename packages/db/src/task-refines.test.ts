import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { projects, runs, tasks } from "./repos.js";
import { taskRefines } from "./task-refines.js";
import { taskRefineMigration } from "./task-refine-schema.js";
import { taskThreads } from "./task-threads.js";

it("upgrades a ledger, keeps one current refine per task, owns its runs, and goes with the task", () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-migration-")),
    file = join(dir, "test.sqlite");
  const raw = new DatabaseSync(file);
  const before = migrations.indexOf(taskRefineMigration);
  for (const migration of migrations.slice(0, before)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
  raw.exec(`PRAGMA user_version=${before}`);
  raw.close();
  const db = Db.open(file);
  try {
    const project = projects.insert(db, { name: "Test", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} });
    const task = tasks.insert(db, {
      projectId: project.id,
      title: "Task",
      spec: "Rough",
      priority: "none",
      labels: [],
      workspaceMode: "current",
      baseRef: "main",
      parentTaskId: null,
      threadId: null,
      origin: "user",
    });
    const recipient = { agent: "codex" as const, model: "test", effort: "high" };
    const base = { title: "Task", spec: "Rough", labels: [] };

    const first = taskRefines.insert(db, { taskId: task.id, recipient, instruction: "", base });
    expect(taskRefines.current(db, task.id)).toMatchObject({ id: first.id, state: "running", suggestion: null });
    const run = runs.insert(db, { id: "refine-run", taskId: null, threadId: null, refineId: first.id, agent: "codex", model: "test", mode: "plan", permissionMode: "review" });
    expect(run).toMatchObject({ refineId: first.id, commentTurnId: null });
    expect(() => runs.insert(db, { id: "two-owners", taskId: task.id, threadId: null, refineId: first.id, agent: "codex", model: "test", mode: "plan", permissionMode: "review" })).toThrow(
      "exactly one",
    );
    taskRefines.update(db, first.id, { runId: run.id, state: "ready", suggestion: { title: "Task", description: "## Goal\nClear.", labels: ["tasks"], note: "Tidied." } });
    expect(taskRefines.forRun(db, run.id)?.suggestion?.labels).toEqual(["tasks"]);

    const second = taskRefines.insert(db, { taskId: task.id, recipient, instruction: "Shorter", base });
    expect(taskRefines.current(db, task.id)?.id).toBe(second.id);
    taskRefines.dismiss(db, second.id);
    expect(taskRefines.current(db, task.id)).toBeNull();
    expect(taskRefines.get(db, first.id)?.state).toBe("ready");

    tasks.delete(db, task.id);
    expect(taskRefines.get(db, first.id)).toBeNull();
    expect(runs.get(db, run.id)).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("upgrades a ledger with its tasks and runs as they were, none of them a Refine's", () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-upgrade-")),
    file = join(dir, "test.sqlite");
  const raw = new DatabaseSync(file);
  const before = migrations.indexOf(taskRefineMigration);
  for (const migration of migrations.slice(0, before)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
  raw.exec(`PRAGMA user_version=${before}`);
  raw.exec("INSERT INTO projects (id,name,root_path,default_branch,settings,created_at,updated_at) VALUES ('p','Fixture','/fixture','main','{}',1,1)");
  raw.exec("INSERT INTO threads (id,project_id,title,agent,mode,permission_mode,created_at,updated_at,last_activity_at) VALUES ('t','p','Chat','codex','act','review',1,1,1)");
  raw.exec("INSERT INTO tasks (id,project_id,thread_id,title,spec,workspace_mode,base_ref,created_at,updated_at) VALUES ('k','p','t','Old task','Rough','current','main',1,1)");
  raw.exec("INSERT INTO runs (id,thread_id,agent,mode,permission_mode,state,started_at) VALUES ('thread-run','t','codex','act','review','success',1)");
  raw.exec("INSERT INTO runs (id,task_id,agent,mode,permission_mode,state,started_at) VALUES ('task-run','k','codex','act','review','success',1)");
  raw.close();
  let db = Db.open(file);
  try {
    expect(db.version).toBe(migrations.length);
    expect(tasks.get(db, "k")).toMatchObject({ title: "Old task", spec: "Rough", threadId: "t" });
    expect(runs.get(db, "thread-run")).toMatchObject({ threadId: "t", taskId: null, refineId: null });
    expect(runs.get(db, "task-run")).toMatchObject({ taskId: "k", threadId: null, refineId: null });
    expect(taskRefines.current(db, "k")).toBeNull();
    expect(taskThreads.list(db, "k")).toEqual([]);
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    db = Db.open(file);
    expect(db.version).toBe(migrations.length);
    expect(runs.get(db, "task-run")).toMatchObject({ taskId: "k", refineId: null });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
