import { afterEach, expect, it } from "vitest";
import { boardColumns } from "./board-columns.js";
import { Db } from "./database.js";
import { projects, tasks } from "./repos.js";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function board() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "Board", rootPath: "/tmp/board-project", gitRemote: null, defaultBranch: "main", settings: {} });
  const columns = boardColumns.save(db, project.id, [
    { name: "Backlog", stage: "backlog" },
    { name: "Build", stage: "in_progress" },
    { name: "Code review", stage: "in_progress" },
    { name: "Done", stage: "done" },
  ]);
  const task = tasks.insert(db, { projectId: project.id, title: "A card", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
  return { db, project, columns, task };
}

it("keeps a project's columns in the order saved, and a kept column's id through a rename", () => {
  const { db, project, columns } = board();
  const [backlog, build, review, done] = columns;
  const saved = boardColumns.save(db, project.id, [{ ...review!, name: "Review by Codex" }, backlog!, build!, done!]);
  expect(saved.map((column) => column.name)).toEqual(["Review by Codex", "Backlog", "Build", "Done"]);
  expect(saved[0]!.id).toBe(review!.id);
});

it("leaves a removed column's task in its status, with no column", () => {
  const { db, project, columns, task } = board();
  const review = columns[2]!;
  tasks.update(db, task.id, { columnId: review.id, status: review.stage }, { explicitStatus: true });
  boardColumns.save(
    db,
    project.id,
    columns.filter((column) => column.id !== review.id),
  );
  expect(tasks.get(db, task.id)).toMatchObject({ status: "in_progress", columnId: null });
});

it("moves a column's tasks with it when its stage changes", () => {
  const { db, project, columns, task } = board();
  const review = columns[2]!;
  tasks.update(db, task.id, { columnId: review.id, status: review.stage }, { explicitStatus: true });
  boardColumns.save(
    db,
    project.id,
    columns.map((column) => (column.id === review.id ? { ...column, stage: "review" as const } : column)),
  );
  expect(tasks.get(db, task.id)).toMatchObject({ status: "review", columnId: review.id });
});

it("takes a task out of its column when its status moves to another stage, and keeps it there otherwise", () => {
  const { db, columns, task } = board();
  const review = columns[2]!;
  tasks.update(db, task.id, { columnId: review.id, status: review.stage }, { explicitStatus: true });
  expect(tasks.update(db, task.id, { status: "in_progress" }, { explicitStatus: true }).columnId).toBe(review.id);
  // A status an agent's work implies does not move a card the person placed.
  expect(tasks.update(db, task.id, { status: "review" })).toMatchObject({ status: "in_progress", columnId: review.id });
  expect(tasks.update(db, task.id, { status: "done" }, { explicitStatus: true })).toMatchObject({ status: "done", columnId: null });
});
