import { expect, it } from "vitest";
import { Db, projects, tasks } from "@openorc/db";
import type { PendingApproval } from "../services/run-types.js";
import { createTaskQueriesHandlers } from "./task-queries.js";

it("reads each task with what its own run waits for the person to approve, and nothing once it settles", async () => {
  const db = Db.memory();
  try {
    const project = projects.insert(db, { name: "fixture", rootPath: "/tmp/task-queries", gitRemote: null, defaultBranch: "main", settings: {} });
    const insert = (title: string) => tasks.insert(db, { projectId: project.id, title, spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
    const waiting = insert("Install the dependencies");
    const quiet = insert("Write the docs");
    let pending: PendingApproval[] = [
      { runId: "task-run", taskId: waiting.id, threadId: null, approvalId: "a1", detail: "pnpm install" },
      { runId: "thread-run", taskId: null, threadId: "thread", approvalId: "a2", detail: "git push" },
    ];
    const handlers = createTaskQueriesHandlers({
      db,
      comments: {} as never,
      threadService: {} as never,
      runService: { pending: () => pending },
    });
    const approvals = async () => Object.fromEntries((await handlers["tasks.list"]({})).map((task) => [task.title, task.approval]));
    expect(await approvals()).toEqual({ "Install the dependencies": "pnpm install", "Write the docs": null });
    expect(await handlers["tasks.get"]({ id: waiting.id })).toMatchObject({ id: waiting.id, approval: "pnpm install" });
    expect(await handlers["tasks.get"]({ id: quiet.id })).toMatchObject({ approval: null });
    pending = [];
    expect(await approvals()).toEqual({ "Install the dependencies": null, "Write the docs": null });
  } finally {
    db.close();
  }
});
