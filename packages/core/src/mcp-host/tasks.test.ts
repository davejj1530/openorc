import { expect, it, vi } from "vitest";
import { createMemoryHost } from "./memory.js";
import { createTaskCreateHost } from "./task-create.js";
import { createTasksHost } from "./tasks.js";

const scope = { spaceId: "space-1", projectId: "project-1" };
const card = (id: string) => ({ id, title: id, status: "backlog", branch: null, current: false, resultSummary: null });

function hosts(online = true) {
  const calls: string[] = [];
  const threadService = {
    toolList: vi.fn(async () => (calls.push("mac list"), [])),
    toolGet: vi.fn(async (_runId: string, id: string) => (calls.push("mac get"), card(id))),
    toolUpdate: vi.fn(async (_runId: string, id: string) => (calls.push("mac update"), card(id))),
    toolStart: vi.fn(async (_runId: string, id: string) => (calls.push("mac start"), { ...card(id), message: "Started" })),
    toolCreate: vi.fn(async () => (calls.push("mac create"), { task: card("new"), duplicate: false, started: false, message: "Saved" })),
  };
  const tools = {
    list: vi.fn(async () => (calls.push("online list"), [])),
    get: vi.fn(async (_runId: string, id: string) => (calls.push("online get"), card(id))),
    update: vi.fn(async (_runId: string, id: string) => (calls.push("online update"), card(id))),
    start: vi.fn(async (_runId: string, id: string) => (calls.push("online start"), card(id))),
    create: vi.fn(async () => (calls.push("online create"), { task: card("new"), duplicate: false, started: false, message: "Saved" })),
    context: vi.fn(async () => (calls.push("online context"), "No task context.")),
    report: vi.fn(async () => (calls.push("online report"), { updateId: "report-1" })),
  };
  const deps = {
    threadService: threadService as never,
    board: { move: vi.fn() },
    reports: { post: vi.fn() },
    dataDir: "/tmp/openorc-tasks-host",
    assertRunAvailable: () => {},
    online: online ? tools : null,
  };
  return { calls, tools, tasks: { ...createTasksHost(deps), create: createTaskCreateHost({ ...deps, created: () => {} }) } };
}

it("sends a call that names a cloud project to the online tools, and every other to this Mac's tasks", async () => {
  const { calls, tasks, tools } = hosts();
  await tasks.list("run", scope);
  await tasks.list("run");
  await tasks.get("run", "a", scope);
  await tasks.update("run", "a", { scope, spec: "Words", ifRevision: 3 });
  await tasks.start("run", "a", { scope });
  await tasks.create("run", { scope, title: "Online task", spec: "Saved on the server." });
  await tasks.create("run", { title: "Mac task", spec: "Saved on this Mac." });
  expect(calls).toEqual(["online list", "mac list", "online get", "online update", "online start", "online create", "mac create"]);
  expect(tools.update).toHaveBeenCalledWith("run", "a", { scope, spec: "Words", ifRevision: 3 });
  expect(tools.start).toHaveBeenCalledWith("run", "a", scope);
});

it("refuses a call that names a cloud project where online task tools are not wired, never falling through to the Mac", async () => {
  const { calls, tasks } = hosts(false);
  await expect(tasks.list("run", scope)).rejects.toThrow("Online task tools aren't available here.");
  await expect(tasks.create("run", { scope, title: "Online task", spec: "Saved on the server." })).rejects.toThrow("Online task tools aren't available here.");
  expect(calls).toEqual([]);
});

it("reads an online task's context from the server, and a Mac run's from its memory", async () => {
  const { tools } = hosts();
  const memory = createMemoryHost({
    memoryService: { taskContext: vi.fn(async () => "Mac context") } as never,
    runService: {} as never,
    db: {} as never,
    assertRunAvailable: () => {},
    taskFor: () => null,
    projectFor: () => null,
    online: tools,
  });
  await expect(memory.taskContext("run", { scope, taskId: "a" })).resolves.toBe("No task context.");
  expect(tools.context).toHaveBeenCalledWith("run", scope, "a");
});

it("posts an update on a team task to the server when the agent names its scope, and never on this Mac's tasks", async () => {
  const { tasks, calls } = hosts(true);
  const scope = { spaceId: "org:studio", projectId: "cloud-project" };
  expect(await tasks.report("run-1", "team-task", { message: "Plan is ready." }, undefined, scope)).toEqual({ updateId: "report-1" });
  expect(calls).toEqual(["online report"]);
  await expect(tasks.report("run-1", "local-task", { message: "x" }, "report-1")).rejects.toThrow("That update is on a task on OpenOrc Cloud.");
});
