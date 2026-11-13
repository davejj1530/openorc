import { expect, it } from "vitest";
import { stageCount, waitingTaskCount } from "./task-stage-counts";

const tasks = [{ status: "proposed" }, { status: "backlog" }, { status: "in_progress" }, { status: "in_progress" }, { status: "review" }, { status: "done" }, { status: "archived" }] as const;

it("counts one stage", () => {
  expect(stageCount(tasks, "in_progress")).toBe(2);
  expect(stageCount(tasks, "backlog")).toBe(1);
});

it("counts proposed and review as waiting on the person, leaving work in progress, backlog, done and archived out", () => {
  expect(waitingTaskCount(tasks)).toBe(2);
  expect(waitingTaskCount([])).toBe(0);
});

it("counts a task whose run waits on an approval, once even when it is also in review", () => {
  const waiting = [
    { status: "in_progress", approval: "Run pnpm install" },
    { status: "in_progress", approval: null },
    { status: "review", approval: "Push to origin" },
  ] as const;
  expect(waitingTaskCount(waiting)).toBe(2);
});
