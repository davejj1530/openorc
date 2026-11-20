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
