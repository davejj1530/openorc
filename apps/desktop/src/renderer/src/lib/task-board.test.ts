import type { BoardColumn, Task } from "@openorc/protocol";
import { expect, it } from "vitest";
import { agentSetupSlot, boardMove, taskBoardColumns } from "./task-board";
import type { TaskRecord } from "./task-records";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

const column = (id: string, name: string, stage: BoardColumn["stage"]): BoardColumn => ({ id, projectId: "project-a", name, stage, job: null, nextColumnId: null, jobEnabled: true });
const board = [column("backlog", "Backlog", "backlog"), column("build", "Build", "in_progress"), column("code-review", "Code review", "in_progress"), column("done", "Done", "done")];
const online = (id: string, patch: Parameters<typeof onlineTask>[0] = {}): TaskRecord => ({
  kind: "online",
  task: onlineTask({ id, ...patch }),
  reference: { ...onlineReference, id },
  project: undefined,
});
const local = (id: string, patch: Partial<Task> = {}): TaskRecord => ({
  kind: "local",
  task: { ...(onlineTask() as unknown as Task), id, projectId: "project-a", status: "backlog", columnId: null, ...patch },
});
const placed = (columns: ReturnType<typeof taskBoardColumns>) => columns.map((each) => [each.name, each.tasks.map((record) => record.task.id)]);

it("draws an organization's cards in its shared columns by their column, and the rest by status", () => {
  const tasks = [
    online("reviewing", { status: "in_progress", columnId: "code-review" }),
    online("building", { status: "in_progress", columnId: "build" }),
    online("older-server", { status: "in_progress" }),
    online("gone", { status: "done", columnId: "a-removed-column" }),
    local("mac", { status: "in_progress", columnId: "code-review" }),
  ];
  expect(placed(taskBoardColumns(tasks, board, "online"))).toEqual([
    ["Backlog", []],
    ["Build", ["building", "older-server", "mac"]],
    ["Code review", ["reviewing"]],
    ["Done", ["gone"]],
  ]);
});

it("keeps an organization's cards by status on a board this computer keeps", () => {
  const tasks = [online("reviewing", { status: "in_progress", columnId: "code-review" }), local("mac", { status: "in_progress", columnId: "code-review" })];
  expect(placed(taskBoardColumns(tasks, board, "local"))).toEqual([
    ["Backlog", []],
    ["Build", ["reviewing"]],
    ["Code review", ["mac"]],
    ["Done", []],
  ]);
});

it("puts a card dropped on a column in it when the board keeps that kind of task, else at the column's stage", () => {
  const [, , review] = taskBoardColumns([], board, "online");
  expect(boardMove(online("a"), review!, "online")).toEqual({ columnId: "code-review" });
  expect(boardMove(local("b"), review!, "online")).toEqual({ status: "in_progress" });
  expect(boardMove(online("a"), review!, "local")).toEqual({ status: "in_progress" });
  const [statuses] = taskBoardColumns([], [], "online");
  expect(boardMove(online("a"), statuses!, "online")).toEqual({ status: "backlog" });
});

it("sets up a column's agent in the column named, else the first working column with no agent, else the first working one", () => {
  const job = { prompt: "Build it.", choice: null };
  const slots = [
    { id: "inbox", name: "Inbox", stage: "backlog" as const },
    { id: "build", name: "Build", stage: "in_progress" as const, job },
    { id: "review", name: "Code review", stage: "in_progress" as const },
    { id: "done", name: "Done", stage: "done" as const },
  ];
  expect(agentSetupSlot(slots, "done")).toBe(3);
  expect(agentSetupSlot(slots, null)).toBe(2);
  expect(agentSetupSlot(slots, "gone")).toBe(2);
  expect(agentSetupSlot([slots[0]!, slots[1]!, slots[3]!], null)).toBe(1);
  expect(agentSetupSlot([slots[0]!, slots[3]!], null)).toBe(0);
});
