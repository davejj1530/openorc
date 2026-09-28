import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { projects, tasks } from "./repos.js";

function taskIn(db: Db) {
  const project = projects.insert(db, { name: "fixture", rootPath: "/tmp/task-status", gitRemote: null, defaultBranch: "main", settings: {} });
  return tasks.insert(db, { projectId: project.id, title: "Explicit task status", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
}

describe("explicit task status", () => {
  it("keeps automatic progression until a user or agent explicitly chooses a status", () => {
    const db = Db.memory();
    try {
      const task = taskIn(db);
      expect(tasks.update(db, task.id, { status: "in_progress" }).status).toBe("in_progress");
      expect(tasks.update(db, task.id, { status: "review" }).status).toBe("review");
      tasks.update(db, task.id, { status: "done", completedAt: 42 }, { explicitStatus: true });
      expect(tasks.update(db, task.id, { status: "in_progress", completedAt: null, spec: "Updated execution metadata" })).toMatchObject({
        status: "done",
        completedAt: 42,
        spec: "Updated execution metadata",
      });
      expect(tasks.update(db, task.id, { status: "review" }).status).toBe("done");
      expect(tasks.update(db, task.id, { status: "backlog", completedAt: null }, { explicitStatus: true })).toMatchObject({ status: "backlog", completedAt: null });
      expect(tasks.update(db, task.id, { status: "review" }).status).toBe("backlog");
    } finally {
      db.close();
    }
  });

  it("retains the explicit status across database reopen and late execution updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "openorc-task-status-"));
    let db = Db.open(join(directory, "fixture.sqlite"));
    try {
      const task = taskIn(db);
      tasks.update(db, task.id, { status: "archived" }, { explicitStatus: true });
      db.close();
      db = Db.open(join(directory, "fixture.sqlite"));
      expect(tasks.update(db, task.id, { status: "review", costUsd: 1 })).toMatchObject({ status: "archived", costUsd: 1 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
