import { expect, it } from "vitest";
import { activeScheduleCount, openTaskCount, stageCount } from "./task-stage-counts";

const tasks = [{ status: "proposed" }, { status: "backlog" }, { status: "in_progress" }, { status: "in_progress" }, { status: "review" }, { status: "done" }, { status: "archived" }] as const;

it("counts one stage", () => {
  expect(stageCount(tasks, "in_progress")).toBe(2);
  expect(stageCount(tasks, "backlog")).toBe(1);
});

it("counts proposed, in progress and review as open, leaving backlog, done and archived out", () => {
  expect(openTaskCount(tasks)).toBe(4);
  expect(openTaskCount([])).toBe(0);
});

it("counts only switched-on schedules", () => {
  expect(activeScheduleCount([{ enabled: true }, { enabled: false }, { enabled: true }])).toBe(2);
});
