import type { BoardColumn, Task } from "@openorc/protocol";
import { expect, it } from "vitest";
import { boardMove } from "./task-board";
import { boardUnion, projectBoards, unionBoardColumns, unionChange, unionSlots } from "./task-board-union";
import type { TaskRecord } from "./task-records";
import { onlineTask } from "./test-fixtures/online-task";

const column = (projectId: string, id: string, name: string, stage: BoardColumn["stage"], patch: Partial<BoardColumn> = {}): BoardColumn => ({
  id,
  projectId,
  name,
  stage,
  job: null,
  nextColumnId: null,
  jobEnabled: true,
  ...patch,
});
const build = { prompt: "Build it.", choice: null };
const kept = [
  column("app", "app-inbox", "Inbox", "backlog"),
  column("app", "app-build", "Build", "in_progress", { job: build, nextColumnId: "app-review" }),
  column("app", "app-review", "Review", "review"),
  column("app", "app-done", "Done", "done"),
  column("site", "site-ideas", "Ideas", "backlog"),
  column("site", "site-build", "build ", "in_progress", { job: { prompt: "Ship the page.", choice: null } }),
  column("site", "site-qa", "QA", "in_progress"),
  column("site", "site-done", "Done", "done"),
];
const boards = projectBoards(["app", "site", "docs"], kept);
const union = boardUnion(boards);
const local = (id: string, projectId: string, patch: Partial<Task> = {}): TaskRecord => ({
  kind: "local",
  task: { ...(onlineTask() as unknown as Task), id, projectId, status: "backlog", columnId: null, ...patch },
});
const saved = (changed: ReturnType<typeof unionChange>) => Object.fromEntries(changed.map((board) => [board.projectId, board.slots.map((slot) => slot.name)]));

it("makes columns of the same name one, ordered by stage, then by where they sit in their boards", () => {
  // "docs" keeps no columns of its own, so it brings the four statuses.
  expect(union.map((each) => [each.name, each.members.map((member) => member.projectId)])).toEqual([
    ["Inbox", ["app"]],
    ["Ideas", ["site"]],
    ["Backlog", ["docs"]],
    ["Build", ["app", "site"]],
    ["In progress", ["docs"]],
    ["QA", ["site"]],
    ["Review", ["app", "docs"]],
    ["Done", ["app", "site", "docs"]],
  ]);
  expect(union.find((each) => each.key === "build")).toMatchObject({ job: build, jobsDiffer: ["site"], next: "review" });
});

it("puts each card in its own project's column, else its project's first column of its status", () => {
  const tasks = [
    local("app-card", "app", { status: "in_progress", columnId: "app-build" }),
    local("site-card", "site", { status: "in_progress", columnId: "site-qa" }),
    local("site-unplaced", "site", { status: "in_progress" }),
    local("docs-card", "docs", { status: "review" }),
  ];
  const columns = unionBoardColumns(tasks, union, boards);
  const placed = columns.filter((each) => each.tasks.length > 0).map((each) => [each.name, each.tasks.map((record) => record.task.id)]);
  expect(placed).toEqual([
    ["Build", ["app-card", "site-unplaced"]],
    ["QA", ["site-card"]],
    ["Review", ["docs-card"]],
  ]);
});

it("drops a card into its own project's column of that name, else at the column's stage", () => {
  const columns = unionBoardColumns([], union, boards);
  const qa = columns.find((each) => each.name === "QA")!;
  expect(boardMove(local("a", "site"), qa, "local")).toEqual({ columnId: "site-qa" });
  expect(boardMove(local("b", "app"), qa, "local")).toEqual({ status: "in_progress" });
});

it("changes a column in every project that has it, and leaves the others alone", () => {
  const slots = unionSlots(union).map((slot) => (slot.id === "build" ? { ...slot, name: "Make" } : slot));
  const changed = unionChange(union, slots, boards);
  expect(saved(changed)).toEqual({ app: ["Inbox", "Make", "Review", "Done"], site: ["Ideas", "Make", "QA", "Done"] });
  // Only the name changed, so each project keeps its own agent.
  expect(changed.find((board) => board.projectId === "site")!.slots[1]).toMatchObject({ id: "site-build", job: { prompt: "Ship the page." } });
});

it("makes a column's agent the same in every project once it changes here, handing on to each project's own column", () => {
  const job = { prompt: "Build it well.", choice: null };
  const slots = unionSlots(union).map((slot) => (slot.id === "build" ? { ...slot, job, nextColumnId: "done" } : slot));
  const changed = unionChange(union, slots, boards);
  expect(changed.map((board) => [board.projectId, board.slots[1]])).toEqual([
    ["app", expect.objectContaining({ job, nextColumnId: "app-done" })],
    ["site", expect.objectContaining({ job, nextColumnId: "site-done" })],
  ]);
});

it("adds a column to every project before its later stages, and removes one from every project that has it", () => {
  const added = unionChange(union, [...unionSlots(union), { name: "Plan", stage: "backlog" }], boards);
  expect(saved(added)).toEqual({
    app: ["Inbox", "Plan", "Build", "Review", "Done"],
    site: ["Ideas", "Plan", "build ", "QA", "Done"],
    docs: ["Backlog", "Plan", "In progress", "Review", "Done"],
  });
  const removed = unionChange(
    union,
    unionSlots(union).filter((slot) => slot.id !== "done"),
    boards,
  );
  expect(saved(removed)).toEqual({ app: ["Inbox", "Build", "Review"], site: ["Ideas", "build ", "QA"], docs: ["Backlog", "In progress", "Review"] });
});

it("places and moves a team's cards by their own project's shared columns on the board of all its projects", () => {
  const online = (id: string, projectId: string, patch: Record<string, unknown> = {}): TaskRecord =>
    ({ kind: "online", task: { ...(onlineTask() as object), id, projectId, status: "in_progress", columnId: null, ...patch }, reference: { id }, project: undefined }) as unknown as TaskRecord;
  const team = projectBoards(["app", "site"], kept).map((board, index) => ({ ...board, revision: index + 4 }));
  const together = boardUnion(team);
  const columns = unionBoardColumns([online("t1", "site", { columnId: "site-qa" }), online("t2", "app")], together, team, "online");
  expect(columns.filter((each) => each.tasks.length).map((each) => [each.name, each.tasks.map((record) => record.task.id)])).toEqual([
    ["Build", ["t2"]],
    ["QA", ["t1"]],
  ]);
  const build = columns.find((each) => each.name === "Build")!;
  expect(boardMove(online("t1", "site"), build, "online")).toEqual({ columnId: "site-build" });
  // A change keeps each board's revision, which its save names.
  const renamed = unionChange(
    together,
    unionSlots(together).map((slot) => (slot.id === "qa" ? { ...slot, name: "Checks" } : slot)),
    team,
  );
  expect(renamed).toEqual([expect.objectContaining({ projectId: "site", revision: 5 })]);
});
