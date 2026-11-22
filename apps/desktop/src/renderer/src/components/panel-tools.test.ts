import { describe, expect, it } from "vitest";
import type { Project, Task, ThreadSummary } from "@openorc/protocol";
import { panelDirectory } from "./panel-tools";

const project = { id: "project", rootPath: "/repo" } as Project;
const task = { id: "task", worktreePath: null } as Task;
const thread = (worktreePath: string | null) => ({ id: "thread", workingDirectory: null, worktreePath }) as ThreadSummary;

describe("a task's panel folder", () => {
  it("is the worktree of the thread the task runs in", () => {
    expect(panelDirectory({ kind: "task", task, project, thread: thread("/worktrees/task") })).toBe("/worktrees/task");
  });

  it("is the project folder until that thread has a worktree, and for a task with no thread", () => {
    expect(panelDirectory({ kind: "task", task, project, thread: thread(null) })).toBe("/repo");
    expect(panelDirectory({ kind: "task", task, project })).toBe("/repo");
  });
});
