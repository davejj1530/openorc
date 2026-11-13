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
