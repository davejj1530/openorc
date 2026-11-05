import { afterEach, describe, expect, it } from "vitest";
import { Db, projects, runs, tasks, threads } from "@openorc/db";
import { relocationRefusal } from "./relocation-rules.js";

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function threadWithTask() {
  const db = Db.memory();
  open.push(db);
  const project = projects.insert(db, { name: "App", rootPath: "/app", gitRemote: null, defaultBranch: null, settings: {} });
  const insert = threads.insert(db, { projectId: project.id, title: "Fix", agent: "claude", model: null, mode: "act", permissionMode: "autonomous", workspaceMode: "worktree" });
  threads.update(db, insert.id, { worktreePath: "/wt/fix", branch: "fix" });
  const task = tasks.insert(db, { projectId: project.id, title: "Do it", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null, threadId: insert.id });
  return { db, thread: threads.get(db, insert.id)!, task };
}

describe("what keeps a thread with tasks from moving", () => {
  it("moves a thread with the tasks it works on", () => {
    const { db, thread } = threadWithTask();
    expect(relocationRefusal(db, thread)).toBeNull();
  });

  it("keeps it put while one of its tasks has runs from outside it", () => {
    const { db, thread, task } = threadWithTask();
    runs.insert(db, { id: "legacy", taskId: task.id, threadId: null, agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
    expect(relocationRefusal(db, thread)).toBe("One of its tasks was worked on outside this conversation, so it can't move.");
  });

  it("keeps it put while one of its tasks has a folder of its own", () => {
    const { db, thread, task } = threadWithTask();
    tasks.update(db, task.id, { worktreePath: "/wt/task" });
    expect(relocationRefusal(db, thread)).toBe("One of its tasks has a folder of its own, so it can't move.");
    tasks.update(db, task.id, { worktreePath: "/wt/fix" });
    expect(relocationRefusal(db, thread)).toBeNull();
  });
});
